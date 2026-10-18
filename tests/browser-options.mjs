// Use the installed Edge channel unless a custom Chromium executable is provided.
export function browserLaunchOptions(env = process.env) {
  const executablePath = env.FRAMECRAFT_BROWSER_EXECUTABLE_PATH?.trim();
  return executablePath ? { executablePath } : { channel: 'msedge' };
}
