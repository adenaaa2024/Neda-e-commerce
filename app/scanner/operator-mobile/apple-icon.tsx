import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iOS home-screen icon — matches operator-mobile PWA manifest entry. */
export default function OperatorMobileAppleIcon() {
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
          borderRadius: 36,
          border: "3px solid #d6b76e",
        }}
      >
        <div
          style={{
            fontSize: 88,
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
