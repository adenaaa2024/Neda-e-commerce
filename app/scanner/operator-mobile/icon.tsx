import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/** PWA / home-screen icon — monogram fallback (no separate brand asset in repo). */
export default function OperatorMobileIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#050607",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 96,
          border: "6px solid #d6b76e",
        }}
      >
        <div
          style={{
            fontSize: 240,
            fontWeight: 700,
            color: "#d6b76e",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1,
          }}
        >
          M
        </div>
      </div>
    ),
    { ...size },
  );
}
