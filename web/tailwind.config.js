/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#faf9f5",
        paper: "#f5f2ea",
        ink: {
          DEFAULT: "#1f1e1d",
          soft: "#3a3835",
          muted: "#6b6862",
          faint: "#9a968e",
        },
        line: {
          DEFAULT: "#e8e4d8",
          strong: "#d9d2c0",
        },
        klein: {
          DEFAULT: "#cc785c",
          soft: "#e8a38e",
          ink: "#8f4a35",
          wash: "#f6e3da",
        },
        success: { DEFAULT: "#3f9142", wash: "#e3efe0" },
        warn: { DEFAULT: "#d97706", wash: "#fbeecf" },
        danger: { DEFAULT: "#c1272d", wash: "#f5d9d9" },
        indigo: { DEFAULT: "#3b4b8a", wash: "#dde1f0", ink: "#27325c" },
        purple: { DEFAULT: "#7c5fa3", wash: "#eae2f2" },
      },
      fontFamily: {
        serif: ['"Fraunces"', "Georgia", "ui-serif", "serif"],
        sans: ['"Geist"', '"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      borderRadius: {
        DEFAULT: "8px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(31,30,29,0.04), 0 1px 2px rgba(31,30,29,0.04)",
        lift: "0 10px 40px -20px rgba(31,30,29,0.25), 0 1px 2px rgba(31,30,29,0.04)",
      },
    },
  },
  plugins: [],
};
