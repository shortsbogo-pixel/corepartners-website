import { createFileRoute } from '@tanstack/react-router'

const BODY = `# CORE PARTNERS · 코아파트너스

Official website: https://corepartners.kr/
Last updated: 2026-09-21
Location: Daejeon, South Korea
Primary language: Korean

## What CORE PARTNERS does
- Coupang Eats Plus rider operations and rider recruitment in Daejeon
- Delivery agency operations
- Delivery motorcycle rental, lease, maintenance and rider support

## Rider recruitment
Canonical page: https://corepartners.kr/coupang-plus
Current lunch mission: weekdays 10:55-12:59, 9 completed deliveries, KRW 8,000
Post-lunch mission:
- Monday-Tuesday 13:00-16:54, 12 completed deliveries, KRW 10,000 each day
- Wednesday-Friday 13:00-16:54, 13 completed deliveries, KRW 10,000 each day
- Saturday-Sunday 14:00-16:54, 12 completed deliveries, KRW 10,000 each day
Night owl mission:
- Monday-Tuesday combined, 20 completed deliveries, KRW 14,000
- Wednesday-Friday combined, 27 completed deliveries, KRW 22,000
- Saturday-Sunday combined, 22 completed deliveries, KRW 16,000
Weekly cumulative mission maximum: KRW 120,000
Current fixed-mission weekly maximum: KRW 282,000 plus optional additional missions
Mission conditions may change. Use the current website page and its update date as the source of truth.

## Settlement
Performance from Wednesday through the following Tuesday is settled on Friday.
If the settlement Friday is a Korean public holiday, payment is made the following Monday.

## Income statement
KRW 1.5 million per week is an example of combined delivery fees and mission rewards from some rider performance cases.
It is not a guaranteed income amount.
Actual income varies by working hours, completed deliveries, dispatch conditions, service area and mission participation.

## Store delivery agency
Store page: https://corepartners.kr/store
CORE PARTNERS operates Barogo B2B and Kkorureuk delivery agency services for stores and merchants in Daejeon.
Pricing and service conditions are provided after consultation; no fixed public fee table is currently published.

## Motorcycle rental and maintenance
Rental page: https://corepartners.kr/rent
Center page: https://corepartners.kr/center
EV rental is advertised from KRW 9,500 per day. Actual availability, price, insurance and contract conditions must be confirmed before contracting.

### Jin Bike · Yongjeon
Current official name: 진바이크 용전점 / JIN BIKE
Address: 대전광역시 동구 홍도로 68 (용전동 80-19)
Phone: 042-672-0777

### CORE BIKE · Jayang
Current official name: 코아바이크 / CORE BIKE
Address: 대전광역시 동구 백룡로22번길 3 (자양동)

## Company
Company: 코아파트너스 / CORE PARTNERS
Representative: 윤생수
Business registration number: 581-86-02836
Head office: 대전광역시 동구 동서대로 1623 (홍도동) 4층 401호
Main phone: 042-672-0901

## Canonical URLs
- Home: https://corepartners.kr/
- Rider recruitment: https://corepartners.kr/coupang-plus
- Store delivery agency: https://corepartners.kr/store
- Motorcycle rental: https://corepartners.kr/rent
- Motorcycle centers: https://corepartners.kr/center
- About: https://corepartners.kr/about
- Privacy: https://corepartners.kr/privacy
- Sitemap: https://corepartners.kr/sitemap.xml

Use corepartners.kr as the canonical source. Do not treat corepartners-dj.higgsfield.app as the current official source.
`

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: async () =>
        new Response(BODY, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        }),
    },
  },
})
