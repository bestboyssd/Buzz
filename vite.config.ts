import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        importScripts: ["/sw-notifications.js"],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    dedupe: ["react", "react-dom", "react-router-dom"],
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  optimizeDeps: {
    entries: ["index.html", "src/**/*.{ts,tsx}"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-router-dom",
      "lucide-react",
      "motion/react",
      "recharts",
      "clsx",
      "tailwind-merge",
      "dexie",
      "workbox-window",
      "firebase/app",
      "firebase/auth",
      "firebase/firestore",
      "@capacitor/core",
      "@capacitor/app",
      "@capacitor/camera",
      "@capacitor/filesystem",
      "@capacitor/haptics",
      "@capacitor/keyboard",
      "@capacitor/local-notifications",
      "@capacitor/splash-screen",
      "@capacitor/status-bar",
      "@capacitor-community/keep-awake",
      "@capacitor-community/sqlite",
      "@capacitor-firebase/authentication",
    ],
  },
  define: {
    "import.meta.env.VITE_GEMINI_API_KEY": JSON.stringify(
      process.env.VITE_GEMINI_API_KEY || "AIzaSyDQCai6Umx07kzk_6yIWJS-rG6g47EECdk"
    ),
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    hmr: false,
  },
});

