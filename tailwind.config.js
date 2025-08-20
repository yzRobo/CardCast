// tailwind.config.js
module.exports = {
    content: [
      "./index.html",
      "./pokemon-match-control.html",
      "./public/**/*.{html,js}",
      "./overlays/**/*.html",
      "./src/**/*.js"
    ],
    theme: {
      extend: {},
    },
    plugins: [require("daisyui")],
    daisyui: {
      themes: [
        {
          cardcast: {
            "primary": "#6366f1",           // Indigo
            "secondary": "#a855f7",         // Purple  
            "accent": "#06b6d4",           // Cyan
            "neutral": "#1e293b",          // Slate
            "base-100": "#0f172a",         // Dark background
            "base-200": "#1e293b",         // Slightly lighter
            "base-300": "#334155",         // Even lighter
            "info": "#3b82f6",             // Blue
            "success": "#10b981",          // Green
            "warning": "#f59e0b",          // Amber
            "error": "#ef4444",            // Red
          },
        },
        "dark",
        "night",
      ],
    },
  }