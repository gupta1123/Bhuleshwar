"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
} from "lucide-react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import styles from "./Login.module.css";

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/")) return "/";
  return value;
}

async function withAuthTimeout<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Authentication timed out. Check the Supabase URL/network and try again."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isLocalDbMode() {
  return process.env.NEXT_PUBLIC_LOCAL_DB_MODE === "true";
}

export function Login() {
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const nextPath = safeNextPath(searchParams.get("next"));
  const initialMessage = searchParams.get("message") || searchParams.get("confirmed");
  const initialError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loadingMode, setLoadingMode] = useState<"signin" | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [message, setMessage] = useState<string | null>(
    initialMessage === "1" ? "Email confirmed. You can sign in now." : (initialMessage ?? null)
  );

  /* ── Scanner animation refs ── */
  const scannerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const stackInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    /* Float the inner doc stack (not the centering wrapper) */
    let floatDir = -1;
    let floatY = 0;
    let floatRaf: number;
    const floatSpeed = 0.04;

    function animateFloat() {
      if (cancelled || !stackInnerRef.current) return;
      floatY += floatSpeed * floatDir;
      if (floatY <= -12 || floatY >= 0) floatDir *= -1;
      stackInnerRef.current.style.transform = `translateY(${floatY}px)`;
      floatRaf = requestAnimationFrame(animateFloat);
    }
    floatRaf = requestAnimationFrame(animateFloat);

    /* Scanner loop */
    function runScan() {
      if (cancelled || !scannerRef.current || !progressRef.current) return;
      const scanner = scannerRef.current;
      const bar = progressRef.current;

      scanner.style.transition = "none";
      scanner.style.top = "0%";
      scanner.style.opacity = "0";
      bar.style.transition = "none";
      bar.style.width = "0%";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          scanner.style.transition = "top 2.6s linear, opacity 0.3s ease";
          scanner.style.top = "100%";
          scanner.style.opacity = "0.85";
          bar.style.transition = "width 2.6s ease";
          bar.style.width = "100%";

          setTimeout(() => {
            if (cancelled) return;
            scanner.style.opacity = "0";
            setTimeout(runScan, 800);
          }, 2700);
        });
      });
    }

    const startTimer = setTimeout(runScan, 400);

    return () => {
      cancelled = true;
      cancelAnimationFrame(floatRaf);
      clearTimeout(startTimer);
    };
  }, []);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoadingMode("signin");
    setError(null);
    setMessage(null);

    if (isLocalDbMode()) {
      window.location.assign(nextPath);
      return;
    }

    try {
      const { data, error: signInError } = await withAuthTimeout(
        supabase.auth.signInWithPassword({
          email,
          password,
        })
      );

      if (signInError) {
        setError(signInError.message);
        setLoadingMode(null);
        return;
      }

      if (!data.session) {
        const {
          data: { session },
        } = await withAuthTimeout(supabase.auth.getSession());

        if (!session) {
          setError("Signed in, but the secure session was not established. Refresh and try again.");
          setLoadingMode(null);
          return;
        }
      }

      window.location.assign(nextPath);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed. Try again.");
      setLoadingMode(null);
    }
  }

  return (
    <main className={styles.page}>

      {/* ════════════════════════════════════
          LEFT PANEL — Dark engine
          ════════════════════════════════════ */}
      <section className={styles.leftPanel}>

        {/* Brand */}
        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <div className={styles.brandDot} />
          </div>
          <span className={styles.brandName}>Kalika.</span>
        </div>

        {/* Scanning document visual */}
        <div className={styles.docStackWrapper}>
          <div className={styles.docStackInner} ref={stackInnerRef}>
            {/* Back layers */}
            <div className={`${styles.docLayer} ${styles.docLayerBack1}`} />
            <div className={`${styles.docLayer} ${styles.docLayerBack2}`} />

            {/* Front document */}
            <div className={`${styles.docLayer} ${styles.docLayerFront}`}>
              {/* Scan line */}
              <div className={styles.scanLine} ref={scannerRef} />

              {/* Doc header */}
              <div className={styles.docHeader}>
                <span className={styles.docId}>PKT-2024-0341</span>
                <span className={styles.docBadge}>CONFIDENTIAL</span>
              </div>

              {/* Fake content lines */}
              <div className={styles.docLines}>
                <div className={styles.docLine} style={{ width: "100%" }} />
                <div className={styles.docLine} style={{ width: "83%" }} />
                <div className={styles.docLine} style={{ width: "100%" }} />
                <div className={styles.docBoxRow}>
                  <div className={styles.docBox} style={{ flex: "1" }} />
                  <div className={styles.docBox} style={{ flex: "2" }} />
                </div>
                <div className={styles.docLine} style={{ width: "100%" }} />
                <div className={styles.docLine} style={{ width: "72%" }} />
                <div className={styles.docLine} style={{ width: "90%" }} />
              </div>

              {/* Progress / extraction bar */}
              <div className={styles.extraction}>
                <div className={styles.extractionLabel}>
                  <div className={styles.extractionPing} />
                  <span>EXTRACTING FIELDS...</span>
                </div>
                <div className={styles.progressTrack}>
                  <div className={styles.progressBar} ref={progressRef} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom copy */}
        <div className={styles.leftFooter}>
          <h2 className={styles.leftHeading}>
            Procurement packet<br />
            <span className={styles.leftAccent}>intelligence engine.</span>
          </h2>
          <div className={styles.leftMeta}>
            <span>● SECURE WORKFLOW</span>
            <span>● FIELD EXTRACTION</span>
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════
          RIGHT PANEL — Light form
          ════════════════════════════════════ */}
      <section className={styles.rightPanel}>

        {/* Status strip */}
        <div className={styles.statusStrip}>
          <div className={styles.statusDot} />
          <span className={styles.statusText}>Systems Operational</span>
        </div>

        {/* Login card */}
        <div className={styles.card}>
          {/* Brutalist corner marks */}
          <div className={`${styles.corner} ${styles.cornerTL}`} />
          <div className={`${styles.corner} ${styles.cornerTR}`} />
          <div className={`${styles.corner} ${styles.cornerBL}`} />
          <div className={`${styles.corner} ${styles.cornerBR}`} />

          <div className={styles.cardHeader}>
            <h1 className={styles.cardTitle}>Identify.</h1>
            <p className={styles.cardSub}>
              Authenticate to access your case workspace.
            </p>
          </div>

          <form className={styles.form} onSubmit={handleSignIn}>
            {/* Email */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="login-email">
                Work Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                className={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {/* Password */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="login-password">
                Password
              </label>
              <div className={styles.inputWrap}>
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  className={`${styles.input} ${styles.inputPassword}`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.eyeBtn}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={loadingMode !== null}
            >
              {loadingMode === "signin" ? (
                <>
                  <Loader2 className={styles.spinIcon} size={16} />
                  Authenticating...
                </>
              ) : (
                "Initialize Session"
              )}
            </button>
          </form>

          {/* Feedback banners */}
          {message && (
            <div className={`${styles.feedback} ${styles.feedbackSuccess}`}>
              <CheckCircle2 size={15} className={styles.feedbackIcon} />
              <span>{message}</span>
            </div>
          )}
          {error && (
            <div className={`${styles.feedback} ${styles.feedbackError}`}>
              <AlertCircle size={15} className={styles.feedbackIcon} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer links */}
        <div className={styles.pageFooter}>
          <a href="#" className={styles.footerLink}>Documentation</a>
          <span className={styles.footerDot}>•</span>
          <a href="#" className={styles.footerLink}>Contact Support</a>
          <span className={styles.footerDot}>•</span>
          <a href="#" className={styles.footerLink}>Legal</a>
        </div>
      </section>
    </main>
  );
}
