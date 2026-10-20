export function isRailwayTrialExpired(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("trial has expired") ||
    lower.includes("please select a plan") ||
    lower.includes("selecta plan") ||
    (lower.includes("railway") && lower.includes("payment required"))
  );
}

export function isFlyPaymentRequired(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("we need your payment information") ||
    lower.includes("add a credit card") ||
    lower.includes("buy credit") ||
    lower.includes("fly.io/dashboard") && lower.includes("billing")
  );
}

export function isCloudBillingBlocked(output: string): boolean {
  return isRailwayTrialExpired(output) || isFlyPaymentRequired(output);
}
