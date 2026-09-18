export const AUTH_EXPIRED_EVENT = "seagull:auth-expired";
export const AUTH_NOTICE_KEY = "seagull_auth_notice";
export const AUTH_EXPIRED_NOTICE = "Your PKG session expired. Sign in again, then continue the same Agent session to rebind it automatically.";

export function notifyAuthExpired(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
}
