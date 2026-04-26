/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        buy:  '#16a34a',
        sell: '#dc2626',
      },
    },
  },
  plugins: [],
}
