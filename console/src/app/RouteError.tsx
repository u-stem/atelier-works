import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";

/**
 * 経路の読み込みや描画が失敗したときの画面。
 * 版の入れ替わりで古いファイルが消えた場合にも出るので、再読み込みを案内する。
 */
export function RouteError() {
  return (
    <div className="p-6">
      <Alert variant="destructive">
        <AlertTitle>画面を表示できませんでした</AlertTitle>
        <AlertDescription>
          <p>
            新しい版に切り替わったか、通信に失敗した可能性があります。再読み込みしてください。
          </p>
          <Button
            size="sm"
            onClick={() => {
              window.location.reload();
            }}
          >
            再読み込み
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
