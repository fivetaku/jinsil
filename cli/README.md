# jinsil — 클진요 (클로드에게 진실을 요구합니다)

내 PC에서 Claude 구독 사용량과 한도 게이지를 기록하고, **구간 계산값만** jinsil.axwith.com에 제출합니다.

```sh
npx jinsil setup      # 한 번만: 기록기·서비스·이 PC 연결(브라우저 승인)·claude 별칭·자동 제출
claude                # 이후 평소처럼. setup이 claude(또는 cc·ccd 같은 claude 별칭)를 기록기 경유로 감쌉니다
jinsil status         # 기록기·연결·자동 제출 상태
jinsil report         # 내 주간 100% 환산·가성비(로컬 계산)
jinsil submit --dry-run  # 서버로 가는 JSON 미리보기
jinsil uninstall      # 서비스·별칭·PATH 원복 (--purge: 로컬 기록 삭제)
```

- 프롬프트·응답·인증값·이메일은 서버로 보내지 않습니다. 원본 장부는 `~/.jinsil/data`에만 남습니다.
- 런타임 의존성 0개, `postinstall` 없음. `setup`을 실행해야 바뀝니다. 셸 설정에는 `# >>> jinsil >>>` 블록 하나만 추가되고, 원래 별칭 줄은 건드리지 않습니다.
- 끄기: `jinsil setup --no-alias`(별칭 없이), `--no-auto-submit`, `jinsil submit --auto off`.
- 라우터·계정 풀(ANTHROPIC_BASE_URL을 바꾸는 별칭, teamclaude 등)을 거치는 사용은 계정별로 나눌 수 없어 기록하지 않습니다.
- 비용은 잠정 API 정가 환산이며 실제 청구액이 아닙니다.
