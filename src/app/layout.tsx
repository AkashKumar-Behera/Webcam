import { Inter, Outfit } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata = {
  title: "Nova - Sync & Watch Together",
  description: "Watch movies, streams, and play together in perfect WebRTC sync with live chat and drawing canvas.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${outfit.variable}`} suppressHydrationWarning>
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL@20..48,100..700,0..1" rel="stylesheet" />
      </head>
      <body>
        <div className="bg-pattern"></div>
        {children}
      </body>
    </html>
  );
}
