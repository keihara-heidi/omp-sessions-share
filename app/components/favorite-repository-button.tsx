"use client";

import { Star } from "lucide-react";
import { useFavoriteRepository } from "@/app/components/use-sessions";
import { BusyIcon } from "@/components/ds/session";
import { Button } from "@/components/ui/button";

export function FavoriteRepositoryButton({
  groupPath,
  groupName,
  favorite,
}: {
  groupPath: string;
  groupName: string;
  favorite: boolean;
}) {
  const { mutate: setFavorite, isPending: isFavoriting } =
    useFavoriteRepository();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-auto min-h-11 min-w-11 text-dim hover:text-foreground aria-pressed:text-warn"
      aria-label={`Favorite ${groupName}`}
      aria-pressed={favorite}
      disabled={isFavoriting}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setFavorite({ groupPath, favorite: !favorite });
      }}
    >
      <BusyIcon
        busy={isFavoriting}
        idle={
          <Star
            aria-hidden
            className={favorite ? "fill-current" : undefined}
          />
        }
      />
    </Button>
  );
}
