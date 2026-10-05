export const gatewayUrl = (endpoint: string): string => {
  const baseUrl = endpoint.trim().replace(/\/v1\/?$/u, "");
  const url = new URL(baseUrl);

  const loopback =
    url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);

  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    baseUrl.includes("?") ||
    baseUrl.includes("#")
  ) {
    throw new Error("Invalid model gateway URL");
  }

  return baseUrl;
};
