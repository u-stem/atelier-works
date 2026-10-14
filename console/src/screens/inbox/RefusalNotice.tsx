import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import type { DecisionRefusal } from "../../lib/approvalRefusal.ts";

/** scriptが確定して断った理由と、承認者が取れる手。トーストは消えるので、バーの中に残す。 */
export function RefusalNotice({ refusal }: { refusal: DecisionRefusal }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{refusal.message}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {refusal.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
