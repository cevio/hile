"use client";

import { useState } from "react";
import styles from "./page.module.css";

interface ResponseData {
  id: number;
  title: string;
  url: string;
  content: string;
}

export function ClickTest() {
  const [data, setData] = useState<ResponseData | null>(null);

  const handleClick = async () => {
    const res = await fetch("/-/post");
    const json: ResponseData = await res.json();
    setData(json);
  };

  return (
    <>
      <button className={styles.secondary} onClick={handleClick}>
        Hile Controller
      </button>

      {data && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,.45)",
            zIndex: 1000,
          }}
          onClick={() => setData(null)}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: "24px 28px",
              minWidth: 320,
              maxWidth: "90vw",
              boxShadow: "0 8px 32px rgba(0,0,0,.18)",
              color: "#111",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>请求结果</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {Object.entries(data).map(([key, val]) => (
                  <tr key={key}>
                    <td
                      style={{
                        padding: "6px 12px 6px 0",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        verticalAlign: "top",
                      }}
                    >
                      {key}
                    </td>
                    <td
                      style={{
                        padding: "6px 0",
                        wordBreak: "break-all",
                      }}
                    >
                      {String(val)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ textAlign: "right", marginTop: 16 }}>
              <button
                onClick={() => setData(null)}
                style={{
                  padding: "6px 20px",
                  borderRadius: 6,
                  border: "1px solid #ccc",
                  background: "#f5f5f5",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
