---
name: drawio-diagram
description: 要件定義や設計の図を draw.io (mxGraph) の XML として手書きで生成するときに使う。viewer.diagrams.net で表示できる自己完結した XML を作る規約を定める。
---

# draw.io (mxGraph) XMLの書き方 (drawio-diagram)

## この図の使われ方

生成したXMLは`viewer.diagrams.net`のURLに埋め込んで表示される(圧縮 + base64 + URLフラグメントの形式)。フラグメント(`#`以降)はブラウザからdiagrams.netのサーバーへは送信されないため、**XML自体がすべての情報を含む自己完結した文書である必要がある**。外部ファイルの参照や相対パスの画像などは使わない。

## 最小スケルトン

```xml
<mxfile host="app.diagrams.net">
  <diagram name="DIAGRAM_NAME" id="UNIQUE_ID">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- vertex と edge をここに追加 -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

- `mxCell id="0"`と`id="1"`(`parent="0"`)はdraw.ioの内部ルートで、必ず両方置く。以降のセルはすべて`parent="1"`から辿れるようにする。
- `diagram`の`id`(`UNIQUE_ID`)はファイル内で一意であればよい(自分で決めた一意な文字列でよい)。
- `diagram`の`name`(`DIAGRAM_NAME`)は、要件定義の出力契約における`diagrams[].name`と同じ値にする。`[a-z0-9-]+`の形式にし、配列内で一意にする。

## vertex(ノード)の書き方

```xml
<mxCell id="node1" value="要求を受け取る" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="160" height="60" as="geometry" />
</mxCell>
```

- `value`が表示テキスト。`style`は`;`区切りのキー=値の羅列(`rounded`, `whiteSpace=wrap`, `html=1`は基本セット)。
- `geometry`の`x`/`y`は左上座標、`width`/`height`はノードサイズ。`as="geometry"`は固定。

## edge(矢印)の書き方

```xml
<mxCell id="edge1" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="node1" target="node2">
  <mxGeometry relative="1" as="geometry" />
</mxCell>
```

- `source` / `target`は接続元・接続先の`vertex`の`id`。ラベルを付けたい場合は`value`に文言を入れる。
- 状態遷移図で条件ラベルを付ける場合も同様に`value`を使う(例: `value="approve"`)。
- `parent`は必ず`"1"`にする(ルートセルを親にする)。
- `mxGeometry`には`as="geometry"`を必ず付ける(`relative="1"`はedge特有の指定)。

## レイアウト規則

- グリッド単位は120pxを基準にする(ノード間の水平・垂直間隔の目安)。
- 原則として上から下(またはフローチャートなら左から右)への一方向レイアウトにする。矢印が交差する配置は避ける。
- 1つの図に詰め込むノード数は目安15個まで。それを超える複雑さになりそうなら、図を分割して「1図1概念」にする(例: 全体構成図と、承認フローだけの図を分ける)。
- 図の種類ごとの目安:
  - **コンテキスト図**: システムと外部アクター(GitHub、Discord、人など)の関係。ノードは少なく、矢印にはやりとりの内容をラベルで書く。
  - **フロー図(擬似シーケンス)**: 処理ステップを上から下に並べ、矢印で順序を表す。分岐は菱形または条件ラベル付きの矢印で表現する。
  - **状態遷移図**: 状態をノード、遷移をラベル付きedgeで表現する。終端状態を視覚的に区別する(色や二重線のstyle)。
  - **データモデル図**: テーブル/エンティティをノードにし、関連をedgeで結ぶ。カラム一覧は`value`内に改行(`&lt;br&gt;`)区切りで列挙してよい。

## 非圧縮XMLであること

- `<mxfile>`に`compressed="true"`を付けない(または省略する)。deflate + base64された圧縮ペイロードではなく、**人が読めるプレーンなXML** をそのまま出力する。
- URLへの埋め込み(圧縮・エンコード)は呼び出し側(`f/factory/lib/drawio.ts`)が行うため、このスキルの責務は「妥当な非圧縮XMLを作ること」までである。

## エスケープ規則

`value`属性やテキスト内で次の文字はXMLエンティティに置き換える。

| 文字 | 置き換え |
| --- | --- |
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"`(属性値内) | `&quot;` |

改行を`value`内に入れたい場合は`&lt;br&gt;`(エスケープ済みの`<br>`)を使う。

## 完全な例(4ノード・3エッジ)

Issue受付から承認までの簡易フロー図:

```xml
<mxfile host="app.diagrams.net">
  <diagram name="issue-intake-flow" id="d1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="n1" value="Issue に factory ラベル" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="160" height="60" as="geometry" />
        </mxCell>
        <mxCell id="n2" value="claim して要件生成" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="40" y="160" width="160" height="60" as="geometry" />
        </mxCell>
        <mxCell id="n3" value="承認待ち(Inbox)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;" vertex="1" parent="1">
          <mxGeometry x="40" y="280" width="160" height="60" as="geometry" />
        </mxCell>
        <mxCell id="n4" value="承認済み" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="40" y="400" width="160" height="60" as="geometry" />
        </mxCell>
        <mxCell id="e1" edge="1" parent="1" source="n1" target="n2">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="e2" edge="1" parent="1" source="n2" target="n3">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="e3" value="approve" edge="1" parent="1" source="n3" target="n4">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## セルフチェック

- `<mxfile>`がルート要素で、`compressed`属性が無い(または`false`)であること。
- すべての`vertex`/`edge`の`parent`が`"1"`を辿れること(孤立セルが無いこと)。
- すべての`source`/`target`が実在する`vertex`の`id`を指していること。
- `&` `<` `>` `"`がエスケープされていること(特にファイル内容やユーザー入力由来のラベルテキスト)。
- 全`mxCell`の`id`が一意であり、`0` / `1`(ルートセル)を再利用していないこと。
- `diagrams[].name`は`[a-z0-9-]+`の形式で配列内一意であり、`<diagram name>`属性の値と一致し、`markdown`内の「図: `<name>`を参照」という参照とも一致していること。
- 非圧縮の生XMLが12KB以内であること。超える場合は図を分割する(「1図1概念」の原則に従う)。
