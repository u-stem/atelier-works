import { PageHeader } from "../../app/PageHeader.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";

export function SystemScreen() {
  return (
    <>
      <PageHeader title="システム" />
      <ComingSoon>
        反映の状態と通知の履歴は、この画面に追加されます。
      </ComingSoon>
    </>
  );
}
