# jinsil — 클진요 (클로드에게 진실을 요구합니다)

내 PC에서 Claude 구독 사용량과 한도 게이지를 기록하고, **구간 계산값만** jinsil.axwith.com에 제출합니다.

```sh
npx jinsil setup      # 기록기 설치·서비스 등록·이 PC 연결(브라우저 승인)
jinsil claude         # 기록기를 거쳐 Claude Code 실행
jinsil report         # 내 주간 100% 환산·가성비(로컬 계산)
jinsil submit         # 첫 회는 보낼 JSON 미리보기 후 동의
jinsil uninstall      # 서비스 해제 (--purge: 로컬 기록 삭제)
```

- 프롬프트·응답·인증값·이메일은 서버로 보내지 않습니다. 원본 장부는 `~/.jinsil/data`에만 남습니다.
- 런타임 의존성 0개, `postinstall` 없음. 설치만으로는 아무것도 바뀌지 않습니다.
- 비용은 잠정 API 정가 환산이며 실제 청구액이 아닙니다.
