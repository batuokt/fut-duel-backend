/**
 * Friendly maç davetleri — socket handlers.
 * Client sözleşmesi: docs/friend-match-backend-plan.md (fut-duel-local)
 */

/** @type {Map<string, { inviterId: string, inviteeId: string, status: string }>} */
const friendInvites = new Map();
/** Client bildirimi: bot maçı vb. sunucu userToGameId dışı oturumlar */
const userActiveMatchSessions = new Map();

function attachFriendMatchHandlers(io, deps) {
  const { supabase, userToSocket, socketToUser, userToGameId, createMatchFromQueueEntries } = deps;

  async function fetchProfile(userId) {
    if (!supabase || !userId) {
      return { username: 'Player', avatar_key: null, rank_score: 0 };
    }
    try {
      const { data } = await supabase
        .from('profiles')
        .select('username, avatar_key, rank_score')
        .eq('id', userId)
        .maybeSingle();
      return {
        username: data?.username ?? 'Player',
        avatar_key: data?.avatar_key ?? null,
        rank_score: data?.rank_score ?? 0,
      };
    } catch (err) {
      console.warn('[friend-match] profile fetch failed:', err);
      return { username: 'Player', avatar_key: null, rank_score: 0 };
    }
  }

  async function verifyFriendship(userA, userB) {
    if (!supabase) return true;
    try {
      const { data, error } = await supabase.rpc('verify_friendship', {
        p_user_a: userA,
        p_user_b: userB,
      });
      if (error) {
        console.warn('[friend-match] verify_friendship:', error.message);
        return false;
      }
      return data === true;
    } catch (err) {
      console.warn('[friend-match] verify_friendship exception:', err);
      return false;
    }
  }

  async function fetchInviteRow(inviteId) {
    if (!supabase || !inviteId) {
      if (!supabase) {
        console.warn('[friend-match] fetch invite skipped — supabase client not configured');
      }
      return null;
    }
    try {
      const { data, error } = await supabase
        .from('friend_match_invites')
        .select('id, inviter_id, invitee_id, status, expires_at')
        .eq('id', inviteId)
        .maybeSingle();
      if (error) {
        console.warn('[friend-match] fetch invite error:', error.message, inviteId);
        return null;
      }
      if (!data) {
        console.warn('[friend-match] invite not found in DB:', inviteId);
        return null;
      }
      return data;
    } catch (err) {
      console.warn('[friend-match] fetch invite failed:', err);
      return null;
    }
  }

  async function loadPendingInvite(inviteId, expectedInviteeId) {
    const row = await fetchInviteRow(inviteId);
    if (!row) return null;
    if (row.status !== 'pending') return null;
    if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;
    if (expectedInviteeId && row.invitee_id !== expectedInviteeId) return null;
    return {
      inviterId: row.inviter_id,
      inviteeId: row.invitee_id,
      status: 'pending',
    };
  }

  async function emitChallengeToInvitee(inviteId, inviterId, inviteeId) {
    const targetSocketId = userToSocket.get(inviteeId);
    if (!targetSocketId) return false;

    const profile = await fetchProfile(inviterId);
    io.to(targetSocketId).emit('friend-challenge-received', {
      inviteId,
      from: {
        id: inviterId,
        username: profile.username,
        avatar_key: profile.avatar_key,
        rank_score: profile.rank_score,
      },
    });
    return true;
  }

  async function startFriendlyMatch(invite) {
    const inviterSocketId = userToSocket.get(invite.inviterId);
    const inviteeSocketId = userToSocket.get(invite.inviteeId);
    if (!inviterSocketId || !inviteeSocketId) {
      console.warn('[friend-match] start failed — offline', invite);
      return false;
    }

    // Bitmiş maç sonrası result ekranında userToGameId kalıntısı friendly eşleşmeyi engelleyebilir.
    if (userToGameId) {
      userToGameId.delete(invite.inviterId);
      userToGameId.delete(invite.inviteeId);
    }
    userActiveMatchSessions.delete(invite.inviterId);
    userActiveMatchSessions.delete(invite.inviteeId);

    const [inviterProfile, inviteeProfile] = await Promise.all([
      fetchProfile(invite.inviterId),
      fetchProfile(invite.inviteeId),
    ]);

    createMatchFromQueueEntries(
      {
        socketId: inviterSocketId,
        odId: invite.inviterId,
        username: inviterProfile.username,
        rank_score: inviterProfile.rank_score,
        avatar_key: inviterProfile.avatar_key,
      },
      {
        socketId: inviteeSocketId,
        odId: invite.inviteeId,
        username: inviteeProfile.username,
        rank_score: inviteeProfile.rank_score,
        avatar_key: inviteeProfile.avatar_key,
      },
      { mode: 'friendly' },
    );

    console.log(
      `[friend-match] started friendly match ${invite.inviterId} vs ${invite.inviteeId}`,
    );
    return true;
  }

  async function markInviteAccepted(inviteId, gameId) {
    if (!supabase || !inviteId) return;
    try {
      await supabase
        .from('friend_match_invites')
        .update({
          status: 'accepted',
          game_id: gameId ?? null,
          responded_at: new Date().toISOString(),
        })
        .eq('id', inviteId)
        .eq('status', 'pending');
    } catch (err) {
      console.warn('[friend-match] mark accepted failed:', err);
    }
  }

  function isUserInActiveGame(userId) {
    if (!userId) return false;
    if (userToGameId?.get(userId)) return true;
    return userActiveMatchSessions.has(userId);
  }

  function notifyInviteeCancelled(inviteId, inviteeId) {
    const inviteeSocketId = userToSocket.get(inviteeId);
    if (inviteeSocketId) {
      io.to(inviteeSocketId).emit('friend-challenge-cancelled', { inviteId });
    }
  }

  return (socket) => {
    socket.on('register-presence', ({ userId, odId }) => {
      const uid = userId || odId;
      if (!uid) return;
      userToSocket.set(uid, socket.id);
      socketToUser.set(socket.id, uid);
      socket.data.userId = uid;
    });

    socket.on('enter-active-game', ({ odId, gameId }) => {
      const uid = odId || socket.data.userId || socketToUser.get(socket.id);
      if (!uid) return;
      userActiveMatchSessions.set(uid, gameId || 'active');
    });

    socket.on('release-active-game', ({ odId, gameId }) => {
      const uid = odId || socket.data.userId || socketToUser.get(socket.id);
      if (!uid) return;
      userActiveMatchSessions.delete(uid);
      if (!userToGameId) return;
      const activeGameId = userToGameId.get(uid);
      if (!activeGameId) return;
      if (gameId && activeGameId !== gameId) return;
      userToGameId.delete(uid);
    });

    socket.on('friend-challenge-precheck', ({ toUserId }, callback) => {
      if (typeof callback !== 'function') return;
      const inviterId = socket.data.userId || socketToUser.get(socket.id);
      if (!inviterId || !toUserId) {
        callback({ ok: false, reason: 'invalid_target' });
        return;
      }
      if (isUserInActiveGame(inviterId)) {
        callback({ ok: false, reason: 'inviter_in_game' });
        return;
      }
      if (isUserInActiveGame(toUserId)) {
        callback({ ok: false, reason: 'invitee_in_game' });
        return;
      }
      callback({ ok: true });
    });

    socket.on('friend-challenge', async ({ toUserId, inviteId }) => {
      const inviterId = socket.data.userId || socketToUser.get(socket.id);
      if (!inviterId || !toUserId || !inviteId) return;

      const memoryInvite = friendInvites.get(inviteId);
      if (memoryInvite?.status === 'accepting') return;

      if (isUserInActiveGame(inviterId) || isUserInActiveGame(toUserId)) {
        const reason = isUserInActiveGame(inviterId) ? 'inviter_in_game' : 'invitee_in_game';
        console.warn('[friend-match] challenge skipped — player in game', reason);
        socket.emit('friend-challenge-rejected', { inviteId, reason });
        return;
      }

      const pending = await loadPendingInvite(inviteId, toUserId);
      if (!pending || pending.inviterId !== inviterId) {
        console.warn('[friend-match] challenge rejected — invite not pending');
        return;
      }

      if (!(await verifyFriendship(inviterId, toUserId))) {
        console.warn('[friend-match] challenge rejected — not friends');
        return;
      }

      friendInvites.set(inviteId, pending);

      const delivered = await emitChallengeToInvitee(inviteId, inviterId, toUserId);
      if (!delivered) {
        console.log('[friend-match] invitee offline, invite stored:', inviteId);
      }
    });

    socket.on('friend-challenge-accept', async ({ inviteId, inviterId, inviteeId }) => {
      const inviteeSocketUserId = socket.data.userId || socketToUser.get(socket.id);
      const pending = await loadPendingInvite(
        inviteId,
        inviteeSocketUserId || inviteeId,
      );
      if (!pending) {
        socket.emit('friend-challenge-cancelled', { inviteId });
        return;
      }

      if (inviterId && pending.inviterId !== inviterId) return;

      if (!(await verifyFriendship(pending.inviterId, pending.inviteeId))) return;

      friendInvites.set(inviteId, pending);
      pending.status = 'accepting';

      const started = await startFriendlyMatch(pending);
      if (started) {
        friendInvites.delete(inviteId);
        await markInviteAccepted(inviteId, userToGameId?.get(pending.inviterId));
      } else {
        pending.status = 'pending';
      }
    });

    socket.on('friend-challenge-decline', async ({ inviteId }) => {
      if (!inviteId) return;

      let inviterId = friendInvites.get(inviteId)?.inviterId;
      friendInvites.delete(inviteId);

      if (!inviterId) {
        const row = await fetchInviteRow(inviteId);
        inviterId = row?.inviter_id;
      }

      if (!inviterId) return;

      const inviterSocketId = userToSocket.get(inviterId);
      if (inviterSocketId) {
        io.to(inviterSocketId).emit('friend-match-declined', { inviteId });
      }
    });

    socket.on('friend-challenge-cancel', async ({ inviteId }) => {
      let inviteeId = friendInvites.get(inviteId)?.inviteeId;
      friendInvites.delete(inviteId);

      if (!inviteeId) {
        const row = await fetchInviteRow(inviteId);
        inviteeId = row?.invitee_id;
      }

      if (inviteeId) {
        notifyInviteeCancelled(inviteId, inviteeId);
      }
    });
  };
}

module.exports = { attachFriendMatchHandlers, friendInvites };
