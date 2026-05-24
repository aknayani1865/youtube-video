const downloaderUrl = import.meta.env.VITE_DOWNLOADER_URL || "https://vidssave.shop";

const openButton = document.querySelector<HTMLElement>("#openDownloader");
openButton?.addEventListener("click", (event) => {
  event.preventDefault();
  window.open(downloaderUrl, "_blank");
});

const shareButton = document.querySelector<HTMLButtonElement>("#shareSite");
shareButton?.addEventListener("click", async () => {
  const shareData = {
    title: "vidssave",
    text: "Open the vidssave video utility.",
    url: downloaderUrl,
  };

  if (navigator.share) {
    await navigator.share(shareData);
    return;
  }

  await navigator.clipboard.writeText(downloaderUrl);
  shareButton.textContent = "Copied";
  window.setTimeout(() => {
    shareButton.textContent = "Share";
  }, 1600);
});
