import React from "react";
import { ShoppingBag, Snowflake, CupSoda, Package, Leaf } from "lucide-react";

interface ProductImagePlaceholderProps {
  name: string;
  category: string;
  size?: number;
  className?: string;
  rounded?: string;
  showBorder?: boolean;
  showShadow?: boolean;
  isHome?: boolean;
  monogramSize?: string;
}

export function ProductImagePlaceholder({
  name,
  category,
  size = 28,
  className = "w-20 h-20",
  rounded = "rounded-2xl",
  showBorder = true,
  showShadow = true,
  isHome = false,
  monogramSize,
}: ProductImagePlaceholderProps) {
  // Select gradient, icon, and colors based on category
  let gradientClass = "";
  let iconColor = "";
  let IconComponent = Package;

  if (category === "fresh") {
    gradientClass =
      "from-emerald-500/20 via-emerald-400/10 to-transparent dark:from-emerald-500/25 dark:via-emerald-400/10 dark:to-transparent border-emerald-500/15 dark:border-emerald-500/20";
    iconColor =
      "text-emerald-600 dark:text-emerald-400 drop-shadow-[0_2px_8px_rgba(16,185,129,0.2)]";
    IconComponent = ShoppingBag;
  } else if (category === "frozen") {
    gradientClass =
      "from-sky-500/20 via-sky-400/10 to-transparent dark:from-sky-500/25 dark:via-sky-400/10 dark:to-transparent border-sky-500/15 dark:border-sky-500/20";
    iconColor =
      "text-sky-600 dark:text-sky-400 drop-shadow-[0_2px_8px_rgba(14,165,233,0.2)]";
    IconComponent = ShoppingBag;
  } else if (category === "cold-drink" || category === "cold drinks") {
    gradientClass =
      "from-indigo-500/20 via-purple-500/10 to-transparent dark:from-indigo-500/25 dark:via-purple-500/10 dark:to-transparent border-indigo-500/15 dark:border-indigo-500/20";
    iconColor =
      "text-indigo-600 dark:text-indigo-400 drop-shadow-[0_2px_8px_rgba(99,102,241,0.2)]";
    IconComponent = ShoppingBag;
  } else {
    gradientClass =
      "from-slate-500/20 via-slate-400/10 to-transparent dark:from-slate-500/25 dark:via-slate-400/10 dark:to-transparent border-slate-500/15 dark:border-slate-500/20";
    iconColor =
      "text-slate-600 dark:text-slate-400 drop-shadow-[0_2px_8px_rgba(100,116,139,0.2)]";
    IconComponent = Package;
  }

  // Get first letter of product name for monogram
  const firstLetter = name ? name.trim().charAt(0).toUpperCase() : "";

  return (
    <div
      className={`${className} bg-gradient-to-br ${gradientClass} ${rounded} flex items-center justify-center ${
        showBorder ? "border" : ""
      } ${
        showShadow
          ? "shadow-[inset_0_1px_2px_rgba(255,255,255,0.4)] dark:shadow-none"
          : ""
      } relative overflow-hidden shrink-0`}
    >
      {/* Subtle glossy radial highlight without GPU blur filter overhead */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.22),transparent_65%)] dark:bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.06),transparent_65%)] pointer-events-none" />

      {/* Large monogram letter back-drop for elegant pos branding feel */}
      {firstLetter && (
        <span
          className={`absolute select-none font-sans leading-none tracking-tighter font-black text-slate-900/[0.04] dark:text-white/[0.03] pointer-events-none ${
            monogramSize
              ? monogramSize
              : isHome
              ? "bottom-0 right-2 text-[108px] sm:text-[120px] font-black"
              : "-bottom-4 -right-2 text-6xl"
          }`}
        >
          {firstLetter}
        </span>
      )}

      {/* Icon */}
      <IconComponent
        size={size}
        className={`relative z-10 ${iconColor}`}
      />
    </div>
  );
}
