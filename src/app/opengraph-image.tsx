import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Og() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", background: "linear-gradient(125deg, #11122B, #31266B 65%, #176078)", padding: 80, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#D9FF73", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 800, color: "#11122B" }}>Z</div>
          <span style={{ color: "#fff", fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>ZAPNIVO</span>
        </div>
        <div style={{ marginTop: 48, color: "#fff", fontSize: 84, fontWeight: 800, lineHeight: 1, textTransform: "uppercase", display: "flex", flexDirection: "column" }}>Life moves.<span style={{ color: "#D9FF73" }}>Power follows.</span></div>
        <div style={{ marginTop: 32, color: "#C8C4E1", fontSize: 28 }}>Portable charger rentals — Minnesota</div>
      </div>
    ),
    size,
  );
}
