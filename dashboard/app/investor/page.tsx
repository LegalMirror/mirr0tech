import type { Metadata } from "next";
import { InvestorDashboard } from "./InvestorDashboard";
import "./investor.css";

export const metadata: Metadata = { title: "Investor dashboard · World Passport & Sepolia" };
export default function InvestorPage() {
  return <InvestorDashboard />;
}
