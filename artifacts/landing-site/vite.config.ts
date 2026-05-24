import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        downloader: resolve(__dirname, "free-youtube-video-downloader.html"),
        youtubeVideoDownloader: resolve(__dirname, "youtube-video-downloader.html"),
        youtubePlaylistDownloader: resolve(__dirname, "youtube-playlist-downloader.html"),
        youtubePlaylistToZip: resolve(__dirname, "youtube-playlist-to-zip.html"),
        youtubeToMp4: resolve(__dirname, "youtube-to-mp4.html"),
        youtubeAudioDownloader: resolve(__dirname, "youtube-audio-downloader.html"),
        youtubeShortsDownloader: resolve(__dirname, "youtube-shorts-downloader.html"),
        downloadYoutubeVideo: resolve(__dirname, "download-youtube-video.html"),
        ytVideoDownloader: resolve(__dirname, "yt-video-downloader.html"),
        youtube1080pDownloader: resolve(__dirname, "youtube-1080p-downloader.html"),
        youtube4kDownloader: resolve(__dirname, "youtube-4k-downloader.html"),
        linkToUs: resolve(__dirname, "link-to-us.html"),
        howToUse: resolve(__dirname, "how-to-use.html"),
        about: resolve(__dirname, "about.html"),
        contact: resolve(__dirname, "contact.html"),
        privacy: resolve(__dirname, "privacy-policy.html"),
        terms: resolve(__dirname, "terms.html"),
        dmca: resolve(__dirname, "dmca.html"),
      },
    },
  },
});
