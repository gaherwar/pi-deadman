// zones.ts — zone classification (GREEN/YELLOW/ORANGE/RED), thresholds, confirmation logic

import type { SystemSignals } from "./signals";

export enum Zone {
  GREEN = "GREEN",
  YELLOW = "YELLOW", 
  ORANGE = "ORANGE",
  RED = "RED"
}

export const POLL_INTERVALS: Record<Zone, number> = {
  [Zone.GREEN]: 5000,
  [Zone.YELLOW]: 2000,
  [Zone.ORANGE]: 1000,
  [Zone.RED]: 1000
};

const CONFIRMATION_REQUIRED = 3;

export class ZoneClassifier {
  public zone: Zone = Zone.GREEN;
  public confirmed: boolean = false;
  public trend: "stable" | "rising" | "falling" = "stable";
  
  private consecutiveCount: number = 0;
  private ratioHistory: number[] = [];

  update(ratio: number, signals: SystemSignals): void {
    const newZone = this.classify(ratio, signals);
    
    // Update zone and confirmation logic
    if (newZone !== this.zone) {
      // Zone changed - reset confirmation counter
      this.zone = newZone;
      this.consecutiveCount = 1;
      this.confirmed = false; // All zones require CONFIRMATION_REQUIRED consecutive polls
    } else {
      // Same zone - increment counter
      this.consecutiveCount++;
      if (this.consecutiveCount >= CONFIRMATION_REQUIRED) {
        this.confirmed = true;
      }
    }

    // Update trend from rolling ratio history
    this.ratioHistory.push(ratio);
    if (this.ratioHistory.length > 5) {
      this.ratioHistory = this.ratioHistory.slice(-5);
    }
    this.trend = this.computeTrend();
  }

  private classify(ratio: number, signals: SystemSignals): Zone {
    // RED overrides - instant and confirmed
    if (ratio > 12 || signals.pressure_level === 4) {
      return Zone.RED;
    }

    // ORANGE: ratio 5-12 with active swapout
    if (ratio >= 5 && signals.swapout_rate > 0) {
      return Zone.ORANGE;
    }

    // YELLOW: ratio 2-5 with active swapout  
    if (ratio >= 2 && signals.swapout_rate > 0) {
      return Zone.YELLOW;
    }

    // GREEN: everything else
    return Zone.GREEN;
  }

  private computeTrend(): "stable" | "rising" | "falling" {
    if (this.ratioHistory.length < 2) {
      return "stable";
    }

    const first = this.ratioHistory[0];
    const latest = this.ratioHistory[this.ratioHistory.length - 1];

    if (first === 0) {
      return "stable";
    }

    // 15% threshold for trend detection
    if (latest > first * 1.15) {
      return "rising";
    } else if (latest < first * 0.85) {
      return "falling";
    } else {
      return "stable";
    }
  }
}

export function shouldBlock(zone: Zone, tier: number): boolean {
  switch (zone) {
    case Zone.GREEN:
    case Zone.YELLOW:
      return false;
    case Zone.ORANGE:
      return tier >= 3;
    case Zone.RED:
      return true;
    default:
      return false;
  }
}
