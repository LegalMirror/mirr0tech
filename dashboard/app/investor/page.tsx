import type { Metadata } from "next";
import { notFound } from "next/navigation";
// Temporarily disabled; restore these imports and the render below to re-enable.
// import { InvestorDashboard } from "./InvestorDashboard";
// import "./investor.css";

export const metadata: Metadata = { title: "Investor dashboard · World Passport & Sepolia" };
export default function InvestorPage() {
  // return <InvestorDashboard />;
  notFound();
}
