import { Inter, Outfit, Poppins, Space_Grotesk, Manrope, Sora } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-display",
});

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-poppins",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

export const metadata = {
  title: "Nova - Sync & Watch Together",
  description: "Watch movies, streams, and play together in perfect WebRTC sync with live chat and drawing canvas.",
};

// Applies saved theme + font before first paint to avoid a flash of the default theme
const themeInitScript = `
try {
  var t = localStorage.getItem("nova_theme");
  if (t) document.documentElement.setAttribute("data-theme", t);
  var f = localStorage.getItem("nova_font");
  if (f) document.documentElement.setAttribute("data-font", f);
} catch (e) {}
`;

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} ${poppins.variable} ${spaceGrotesk.variable} ${manrope.variable} ${sora.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL@20..48,100..700,0..1" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <div className="bg-pattern"></div>
        {children}
      </body>
    </html>
  );
}
