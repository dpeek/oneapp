export const appName = "Orumai";
export const defaultServerUrl = "https://app.dpeek.com";
export const workspacePath = "/app";
export const vaultPath = `${workspacePath}/vault`;

export const isWorkspacePath = (pathname: string) =>
  pathname === workspacePath || pathname.startsWith(`${workspacePath}/`);
