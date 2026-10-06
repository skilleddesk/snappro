/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brighter greys for text and icons: the dark surfaces swallowed the default ones.
        slate: {
          300: "#dbe3f0",
          400: "#bcc7d8",
          500: "#a3b0c4",
          600: "#8e9bb1",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};