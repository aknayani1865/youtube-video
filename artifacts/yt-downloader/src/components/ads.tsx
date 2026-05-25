import { useEffect, useRef } from "react";

type AdsConfig = {
  popunderHtml?: string;
  socialBarHtml?: string;
  smartlinkUrl?: string;
  smartlinkHtml?: string;
  nativeBannerHtml?: string;
  banner728x90Html?: string;
  banner468x60Html?: string;
};

declare global {
  interface Window {
    __VIDSSAVE_ADS__?: AdsConfig;
  }
}

function getAdsConfig(): AdsConfig {
  return window.__VIDSSAVE_ADS__ ?? {};
}

function mountAdHtml(container: HTMLElement, html: string) {
  container.innerHTML = html;

  const scripts = Array.from(container.querySelectorAll("script"));
  for (const oldScript of scripts) {
    const script = document.createElement("script");

    for (const attr of Array.from(oldScript.attributes)) {
      script.setAttribute(attr.name, attr.value);
    }

    script.text = oldScript.text;
    oldScript.replaceWith(script);
  }
}

function useAdHtml(html: string | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current || !html?.trim()) return;
    mountAdHtml(ref.current, html);
  }, [html]);

  return ref;
}

export function PageAdScripts() {
  useEffect(() => {
    const ads = getAdsConfig();
    const snippets = [ads.popunderHtml, ads.socialBarHtml].filter((value): value is string => Boolean(value?.trim()));
    if (snippets.length === 0) return;

    const host = document.createElement("div");
    host.hidden = true;
    host.setAttribute("data-vidssave-page-ads", "true");
    document.body.appendChild(host);

    mountAdHtml(host, snippets.join("\n"));

    return () => host.remove();
  }, []);

  return null;
}

export function AdSlot({ type, className = "" }: { type: "banner728x90" | "banner468x60" | "nativeBanner" | "smartlink"; className?: string }) {
  const ads = getAdsConfig();
  const html =
    type === "banner728x90" ? ads.banner728x90Html :
    type === "banner468x60" ? ads.banner468x60Html :
    type === "nativeBanner" ? ads.nativeBannerHtml :
    ads.smartlinkHtml;
  const ref = useAdHtml(html);
  const smartlinkUrl = type === "smartlink" ? ads.smartlinkUrl : "";

  if (!html?.trim() && !smartlinkUrl?.trim()) return null;

  if (type === "smartlink" && smartlinkUrl?.trim() && !html?.trim()) {
    return (
      <a
        href={smartlinkUrl}
        target="_blank"
        rel="nofollow sponsored noopener noreferrer"
        className={`block rounded-xl border border-border/40 bg-card px-4 py-3 text-center text-sm font-semibold text-primary transition-colors hover:border-primary/40 hover:bg-accent/40 ${className}`}
      >
        Sponsored
      </a>
    );
  }

  return (
    <div
      ref={ref}
      data-ad-slot={type}
      className={`ad-slot ad-slot-${type} ${className}`}
    />
  );
}
