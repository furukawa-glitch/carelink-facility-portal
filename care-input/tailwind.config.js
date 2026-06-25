/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // 老眼・現場対応のためベース文字を大きめに
      fontSize: {
        base: ['1.0625rem', { lineHeight: '1.6rem' }],
      },
    },
  },
  plugins: [],
};
