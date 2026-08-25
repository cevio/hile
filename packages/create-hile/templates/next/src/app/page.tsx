import { randomUUID } from 'node:crypto';
import { createExecutionContext } from '@hile/context';
import Image from "next/image";
import styles from "./page.module.css";
import { ClickTest } from "./click";
import { loadModel } from "@hile/model";
import homeModel from "@/models/home/home.model";

export const dynamic = "force-dynamic";

export default async function Home() {
  const home = await loadModel(homeModel, {}, {
    context: createExecutionContext({ requestId: randomUUID() }),
    signal: new AbortController().signal,
  });

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Image
          className={styles.logo}
          src="/next.svg"
          alt="Next.js logo"
          width={100}
          height={20}
          priority
        />
        <div className={styles.intro}>
          <h1>{home.heading}</h1>
          <p>{home.tagline}</p>
        </div>
        <div className={styles.ctas}>
          <a
            className={styles.primary}
            href="https://github.com/cevio/hile"
            target="_blank"
            rel="noopener noreferrer"
          >
            Hile on GitHub
          </a>
          <ClickTest />
        </div>
      </main>
    </div>
  );
}
