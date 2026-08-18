import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Shorten a home-rooted absolute path for compact dashboard display. */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}
