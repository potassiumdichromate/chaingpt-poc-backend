/**
 * Wire shapes of the real KULT Creator Studio API (@kult/creator-backend).
 *
 * Transcribed from the production source:
 *   services/gameFactoryService.js   -> game package
 *   controllers/gameController.js    -> publish block, list/show responses
 *   services/socialService.js        -> getSocialStats
 *   services/activityService.js      -> activity documents
 *   services/pointsService.js        -> getProfileUsername, point summary
 *
 * Everything is optional: these documents are written by several code paths over
 * time (template games, pure-agent games, refined games), so a field present on
 * one record is routinely absent on another.
 */

export interface KultGamePackage {
  id: string;
  title?: string;
  /** "template" | "ai-refinement" | "pure-agent" - observed live. */
  tier?: string;
  templateId?: string;
  templateName?: string;
  category?: string;
  creatorId?: string;
  views?: number;
  createdAt?: string;
  updatedAt?: string;
  thumbnailUrl?: string | null;
  remixOf?: string | null;
  buildStatus?: string;
  /** Generation metadata, e.g. "15s". */
  createdIn?: string;
  /** e.g. "90%". */
  reliability?: string;
  apiCost?: number;

  /** Per-game engagement rollup. Live data has this populated far more often than
   *  the social collections, so it is the primary engagement source. */
  points?: { plays?: number; likes?: number; shares?: number; total?: number };

  generation?: { mode?: string; prompt?: string };

  customization?: {
    prompt?: string;
    theme?: string;
    difficulty?: string;
    level?: string;
    extra?: string;
  };

  gameplay?: {
    /** Live data: usually a string, occasionally a string[] of mechanic bullets. */
    mechanic?: string | string[];
    /** Live data: string, string[], or a keyed map like { move: "WASD", dash: "Shift" }. */
    controls?: string | string[] | Record<string, unknown>;
    tuning?: Record<string, unknown>;
    states?: string[];
    scoring?: string;
    /** string[] on template games, a single string on generated games. */
    collision?: string[] | string;
  };

  /** `assets` is a string on template games and a string[] on generated games. */
  visuals?: { mood?: string; colors?: string[]; assets?: string | string[] };
  build?: { runtime?: string; renderer?: string; targetFps?: number; publishReady?: boolean };

  publish?: {
    published?: boolean;
    status?: string;
    publishedAt?: string;
    playPath?: string;
  };

  browserFeature?: { featured?: boolean; featuredAt?: string };
  refinement?: { generatedCode?: string };
}

/** GET /social/stats/:gameId */
export interface KultSocialStats {
  likes?: { liked?: boolean; count?: number };
  comments?: { count?: number };
  favorites?: { favorited?: boolean; count?: number };
  shares?: { count?: number };
  views?: { count?: number };
}

/** GET /social/profile/:userId */
export interface KultProfile {
  userId?: string;
  username?: string | null;
}

/** GET /social/activity/user/:userId - activityType values come from zeroGActivityLog ACTIVITY. */
export interface KultActivity {
  userId?: string;
  gameId?: string | null;
  gameTitle?: string | null;
  activityType?: string;
  details?: string;
  timestamp?: string;
}

/** GET /social/points/:userId */
export interface KultPointSummary {
  lifetimePoints?: number;
  lifetimeScore?: number;
  dailyPoints?: Record<string, unknown>;
  weeklyPoints?: Record<string, unknown>;
}

/** Real KULT activity types (services/zeroGActivityLog.js ACTIVITY). */
export const KULT_ACTIVITY = {
  LOGIN: 'login',
  GAME_GENERATED: 'game_generated',
  GAME_EDITED: 'game_edited',
  GAME_PUBLISHED: 'game_published',
  PLAY_STARTED: 'play_started',
  PLAY_QUALIFIED: 'play_qualified',
  GAME_COMPLETED: 'game_completed',
  SCORE_SUBMITTED: 'score_submitted',
  LIKE: 'like',
  SHARE: 'share',
  FOLLOW: 'follow',
  REFERRAL: 'referral_attributed',
  POINTS_AWARDED: 'points_awarded',
  PAYMENT: 'payment',
  ASSET_STORED: 'asset_stored',
} as const;
