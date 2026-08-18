import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

function requestOrigin(requestHeaders: Headers): string {
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host.startsWith("localhost")
        ? "http"
        : "https";
  try {
    return new URL(protocol + "://" + host).origin;
  } catch {
    return "http://localhost:3000";
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const origin = requestOrigin(await headers());
  const socialImage = new URL("/og.png", origin).toString();
  return {
    metadataBase: new URL(origin),
    title: {
      default: "Office Translator｜尽量保留原结构的文档翻译",
      template: "%s｜Office Translator",
    },
    description:
      "兼容 WPS Office 与 Microsoft Office，支持 Word、Excel 和 PowerPoint（PPT）文件翻译，尽量保留文档结构与格式。",
    openGraph: {
      type: "website",
      title: "Office Translator",
      description: "翻译内容，尽量保留原文档结构。",
      images: [{ url: socialImage, width: 1737, height: 907 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Office Translator",
      description: "翻译内容，尽量保留原文档结构。",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const analyticsScriptUrl = process.env.NEXT_PUBLIC_ANALYTICS_SCRIPT_URL;
  const analyticsWebsiteId = process.env.NEXT_PUBLIC_ANALYTICS_WEBSITE_ID;

  return (
    <html lang="zh-CN">
      <head>
        {analyticsScriptUrl && analyticsWebsiteId ? (
          <script
            defer
            src={analyticsScriptUrl}
            data-website-id={analyticsWebsiteId}
          />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
