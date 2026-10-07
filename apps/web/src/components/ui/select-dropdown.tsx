"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectDropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  width?: string;
  size?: "sm" | "default";
}

export function SelectDropdown({
  value,
  onChange,
  options,
  placeholder = "Select...",
  className = "",
  triggerClassName = "",
  contentClassName = "",
  width,
  size = "default",
}: SelectDropdownProps) {
  const [open, setOpen] = React.useState(false);

  const selectedOption = options.find((opt) => opt.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-xs font-medium text-[#111827] shadow-sm transition-all hover:bg-white hover:border-[#b9aa99] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#b9aa99]",
            size === "sm" ? "h-7 px-2 text-[11px]" : "h-9 px-3",
            triggerClassName,
            className
          )}
        >
          <span className="truncate text-left">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-[#8a7f72] transition-transform duration-200",
              open && "rotate-180 text-[#3d3530]"
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn(
          "z-50 min-w-[160px] max-h-64 overflow-y-auto rounded-lg border border-[#e0d8cc] bg-white p-1 text-xs text-[#111827] shadow-lg outline-none",
          width || "w-[var(--radix-popover-trigger-width)]",
          contentClassName
        )}
      >
        <div className="flex flex-col gap-0.5">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "relative flex cursor-pointer select-none items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors outline-none",
                  isSelected
                    ? "bg-[#ede6d9] text-[#111827] font-semibold"
                    : "text-[#3d3530] hover:bg-[#f5efe6] hover:text-[#111827]"
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-[#2b1a10]" />
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
