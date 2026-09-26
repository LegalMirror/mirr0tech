import { BASE } from "@/lib/base";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "./AppShell";
import { Providers } from "./providers";
import { WorldSessionProvider } from "./WorldSessionProvider";

const TAGLINE = "Legal documents compiled to executable policy";
const PITCH =
  "Every on-chain decision traceable to a verbatim clause: the document, the rule, the logic, the bytes and the contract that enforces it.";

export const metadata: Metadata = {
  title: { default: `mirr0tech — ${TAGLINE}`, template: "%s · mirr0tech" },
  description: PITCH,
  manifest: `${BASE}/site.webmanifest`,
  icons: { icon: [{ url: `${BASE}/mark.svg`, type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  themeColor: "#060a18",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* No-FOUC: stamp the saved theme on <html> before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('mirrortech.theme');if(m==='light'||m==='dark')document.documentElement.dataset.theme=m;}catch(e){}})();`,
          }}
        />
        <WorldSessionProvider>
          <Providers>
            <AppShell>{children}</AppShell>
          </Providers>
        </WorldSessionProvider>
      </body>
    </html>
  );
}
