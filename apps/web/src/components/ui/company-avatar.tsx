import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const avatarGradients = [
  "bg-[linear-gradient(145deg,#f0c27b_0%,#dca34d_48%,#5fa566_100%)]",
  "bg-[linear-gradient(145deg,#91b9c8_0%,#6f8fa8_48%,#5f718f_100%)]",
  "bg-[linear-gradient(145deg,#e6ae8a_0%,#cb806d_50%,#9b6877_100%)]",
  "bg-[linear-gradient(145deg,#c9b878_0%,#9da66a_48%,#62856f_100%)]",
] as const;

const avatarSizes = {
  sm: "h-7 w-7 rounded-lg text-[10px]",
  md: "h-11 w-11 rounded-xl text-sm",
} as const;

function initialsForCompany(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "CO";
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function gradientForCompany(name: string) {
  const hash = [...name.toLowerCase()].reduce(
    (total, character) => (total * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return avatarGradients[hash % avatarGradients.length];
}

export function CompanyAvatar({
  className,
  name,
  size = "sm",
  verified = false,
}: {
  className?: string;
  name: string;
  size?: keyof typeof avatarSizes;
  verified?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center font-extrabold tracking-tight text-white",
        avatarSizes[size],
        gradientForCompany(name),
        className,
      )}
    >
      {initialsForCompany(name)}
      {verified ? (
        <span className="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-white bg-[#4ca154] text-white">
          <Check className="h-2 w-2" strokeWidth={3} />
        </span>
      ) : null}
    </span>
  );
}
