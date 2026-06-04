const LOGIN_INTRO_SEEN_KEY = "menorix:loginIntroSeen";

/** True when the user has already seen the login intro this browser profile. */
export function hasSeenLoginIntro(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOGIN_INTRO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist that the login intro was shown or skipped. */
export function markLoginIntroSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOGIN_INTRO_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}
