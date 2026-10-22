export interface RecoveryState {
  userId: string | null;
  blocked: boolean;
  blockedUsers: readonly string[];
  restored: boolean;
  returning: boolean;
}
export const initialRecovery: RecoveryState = { userId: null, blocked: false, blockedUsers: [], restored: false, returning: false };
/** Cada bloqueo observado se consume una sola vez, para esa identidad y sesión. */
export function updateRecovery(previous: RecoveryState, userId: string | null, blocked: boolean): RecoveryState {
  if (previous.userId === userId && previous.blocked === blocked) return previous;
  if (!userId) return initialRecovery;
  const wasBlocked = previous.blockedUsers.includes(userId);
  return {
    userId, blocked, returning: !blocked && (previous.blocked || wasBlocked),
    blockedUsers: blocked ? [...new Set([...previous.blockedUsers, userId])] : previous.blockedUsers.filter(id => id !== userId),
    restored: !blocked && wasBlocked,
  };
}
