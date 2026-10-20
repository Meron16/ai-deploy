export function extractDeployUrls(output: string): string[] {
  const matches = output.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  const unique = new Set<string>();

  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;]+$/, "");
    if (
      cleaned.includes("railway.app") ||
      cleaned.includes("vercel.app") ||
      cleaned.includes("up.railway.app") ||
      cleaned.includes(".fly.dev") ||
      cleaned.includes("trycloudflare.com")
    ) {
      unique.add(cleaned);
    }
  }

  return [...unique];
}

export function pickPrimaryDeployUrl(urls: string[]): string | undefined {
  return (
    urls.find((url) => url.includes("trycloudflare.com")) ??
    urls.find((url) => url.includes(".fly.dev")) ??
    urls.find((url) => url.includes("up.railway.app")) ??
    urls.find((url) => url.includes("vercel.app")) ??
    urls[0]
  );
}
