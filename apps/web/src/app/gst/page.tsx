import type { Metadata } from "next";
import GstReconciliationPage from "@/components/gst/GstReconciliationPage";

export const metadata: Metadata = { title: "GST Reconciliation · Bhuleshwar" };

export default function GstPage() {
  return <GstReconciliationPage />;
}
