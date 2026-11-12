# Sohbet

Mesajlaşma, görüldü bilgisi, çevrimiçi durumu, emoji, sesli ve görüntülü arama.
Telefon, bilgisayar ve tablette tarayıcıdan çalışır. Aynı hesapla birden fazla cihazdan girilebilir.

Gereken tek şey **Node.js 18 veya üstü**. Kurulacak paket yok.

## 1) Kendi bilgisayarında dene

```
node server.js
```

Ekranda adresler çıkar:

- Bilgisayarda: `http://localhost:3000`
- Aynı Wi-Fi'daki telefon: `http://192.168.x.x:3000` (ekranda yazan adres)

Önemli: tarayıcılar mikrofon ve kameraya sadece `https://` sayfalarda (bir de `localhost`'ta) izin verir.
Telefonda `http://192...` adresiyle mesajlaşma çalışır ama **arama çalışmaz**.
Arkadaşınla internet üzerinden konuşmak için sunucuyu aşağıdaki gibi internete koy.

## 2) İnternete koy (arkadaşınla her yerden konuşmak için)

Node.js çalıştıran herhangi bir barındırma olur (Render, Railway, Fly.io, kendi sunucun...). Render örneği:

1. Bu klasörü bir GitHub deposuna yükle.
2. render.com'da **New → Web Service** ile depoyu seç.
3. Build Command: boş bırak. Start Command: `node server.js`
4. Verdiği `https://...onrender.com` adresini arkadaşınla paylaş. Arama bu adreste çalışır.

**Veri kalıcılığı:** Hesaplar ve mesajlar `data.json` dosyasında tutulur. Ücretsiz planlarda disk genelde
sıfırlanır; sunucu yeniden başladığında hesaplar silinebilir. Kalıcı disk (volume) bağlayıp
`DATA_DIR` ortam değişkenini o diskin yoluna ayarla (örn. `DATA_DIR=/data`).

## Ayarlar (ortam değişkenleri)

| Değişken | Anlamı |
|---|---|
| `PORT` | Dinlenecek port (varsayılan 3000) |
| `DATA_DIR` | `data.json` dosyasının yazılacağı klasör |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | İsteğe bağlı TURN sunucusu. Bazı mobil ağlarda aramanın bağlanması için gerekebilir |

## Bilmen gerekenler

- Şifreler düz metin değil, `scrypt` ile özetlenerek saklanır. Mesajlar ise sunucuda **şifrelenmeden** durur; sunucuyu işleten kişi okuyabilir.
- Şifre sıfırlama yok. Şifreyi unutan yeni hesap açmalı.
- Aramalar tarayıcılar arasında doğrudan (WebRTC) kurulur, ses ve görüntü sunucudan geçmez.
  Sunucu sadece bağlantıyı kurdurur. Birkaç kişilik kullanım için tasarlandı.
- Uygulama açık değilken telefona bildirim gelmez (sekme açıkken ya da arka plandayken tarayıcı bildirimi çıkar).
