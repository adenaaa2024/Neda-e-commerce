import type { ClaimCenterFlowStepId } from "./claim-center-flow-nav";

export type CommandBoardStepMeta = {
  explanation: string;
  nextAction: string;
  /** When money display is allowed on this step card */
  showMoney: boolean;
};

export const CLAIM_CENTER_COMMAND_BOARD_META: Record<ClaimCenterFlowStepId, CommandBoardStepMeta> = {
  find_money: {
    explanation: "Recoverable events with known or unknown expected value.",
    nextAction: "Review highest-value opportunities",
    showMoney: true,
  },
  review: {
    explanation: "Human decisions before filing — product, reference, and proof blockers.",
    nextAction: "Work the review queue",
    showMoney: false,
  },
  proof: {
    explanation: "Photos, notes, and source snapshots still missing.",
    nextAction: "Preview proof packets",
    showMoney: false,
  },
  product: {
    explanation: "Catalog linkage blocking recovery filing.",
    nextAction: "Open product match queue",
    showMoney: false,
  },
  references: {
    explanation: "Amazon reference IDs — conflicts need operator review.",
    nextAction: "Inspect reference links",
    showMoney: false,
  },
  recovery: {
    explanation: "Observed filed and reimbursement from imports — not Menorix filing.",
    nextAction: "Confirm observed outcomes",
    showMoney: true,
  },
  sources: {
    explanation: "Generator runs and intake health for your store.",
    nextAction: "Check source activity",
    showMoney: false,
  },
};
