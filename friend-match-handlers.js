/**
 * Friendly maç davetleri — socket handlers.
 * Client sözleşmesi: docs/friend-match-backend-plan.md (fut-duel-local)
 */

/** @type {Map<string, { inviterId: string, inviteeId: string, status: string }>} */
const friendInvites = new Map();

function attachFriendMatchHandlers(io, deps) {
  const { supabase, userToSocket, socketToUser, createMatchFromQueueEntries } = deps;

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

  function resolveInvite(inviteId, inviterId, inviteeId, inviteeSocketUserId) {
    let invite = friendInvites.get(inviteId);
    if (invite) return invite;
    if (!inviteId || !inviterId || !inviteeId) return null;
    if (inviteeSocketUserId && inviteeSocketUserId !== inviteeId) return null;
    invite = { inviterId, inviteeId, status: 'pending' };
    friendInvites.set(inviteId, invite);
    return invite;
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

  return (socket) => {
    socket.on('register-presence', ({ userId, odId }) => {
      const uid = userId || odId;
      if (!uid) return;
      userToSocket.set(uid, socket.id);
      socketToUser.set(socket.id, uid);
      socket.data.userId = uid;
    });

    socket.on('friend-challenge', async ({ toUserId, inviteId }) => {
      const inviterId = socket.data.userId || socketToUser.get(socket.id);
      if (!inviterId || !toUserId || !inviteId) return;

      if (!(await verifyFriendship(inviterId, toUserId))) {
        console.warn('[friend-match] challenge rejected — not friends');
        return;
      }

      friendInvites.set(inviteId, {
        inviterId,
        inviteeId: toUserId,
        status: 'pending',
      });

      const delivered = await emitChallengeToInvitee(inviteId, inviterId, toUserId);
      if (!delivered) {
        console.log('[friend-match] invitee offline, invite stored:', inviteId);
      }
    });

    socket.on('friend-challenge-accept', async ({ inviteId, inviterId, inviteeId }) => {
      const inviteeSocketUserId = socket.data.userId || socketToUser.get(socket.id);
      const invite = resolveInvite(inviteId, inviterId, inviteeId, inviteeSocketUserId);
      if (!invite || invite.status !== 'pending') return;

      if (!(await verifyFriendship(invite.inviterId, invite.inviteeId))) return;

      invite.status = 'accepting';
      const started = await startFriendlyMatch(invite);
      if (started) {
        invite.status = 'accepted';
        friendInvites.delete(inviteId);
      } else {
        invite.status = 'pending';
      }
    });

    socket.on('friend-challenge-decline', ({ inviteId }) => {
      const invite = friendInvites.get(inviteId);
      if (!invite) return;
      invite.status = 'declined';
      const inviterSocketId = userToSocket.get(invite.inviterId);
      if (inviterSocketId) {
        io.to(inviterSocketId).emit('friend-match-declined', { inviteId });
      }
      friendInvites.delete(inviteId);
    });

    socket.on('friend-challenge-cancel', ({ inviteId }) => {
      const invite = friendInvites.get(inviteId);
      if (!invite) return;
      invite.status = 'cancelled';
      const inviteeSocketId = userToSocket.get(invite.inviteeId);
      if (inviteeSocketId) {
        io.to(inviteeSocketId).emit('friend-challenge-cancelled', { inviteId });
      }
      friendInvites.delete(inviteId);
    });
  };
}

module.exports = { attachFriendMatchHandlers, friendInvites };
