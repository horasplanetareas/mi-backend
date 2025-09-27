const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const logger = require("./logger"); // 👈 Importamos el logger

// ===== MercadoPago SDK v2 =====
const { MercadoPagoConfig, PreApproval } = require("mercadopago");
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const preapproval = new PreApproval(mpClient);

// ===== PayPal SDK =====
const paypal = require("@paypal/checkout-server-sdk");
function paypalClient() {
  return new paypal.core.PayPalHttpClient(
    new paypal.core.LiveEnvironment(
      process.env.PAYPAL_CLIENT_ID,
      process.env.PAYPAL_CLIENT_SECRET
    )
  );
}

// ===== Firebase =====
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  logger.info("🔥 Firebase inicializado");
}
const db = admin.firestore();

// ===== Express =====
const app = express();
app.use(cors());

// Parser para JSON y URL-encoded
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook-stripe") {
    next(); // Stripe usa express.raw
  } else {
    express.json()(req, res, () => {
      express.urlencoded({ extended: true })(req, res, next);
    });
  }
});

// =======================
// Stripe Checkout
// =======================
app.post("/stripe-checkout", async (req, res) => {
  logger.info("⚡ [Stripe Checkout] Request body: " + JSON.stringify(req.body));
  try {
    const { priceId, email, uid } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      customer_email: email,
      metadata: { uid },
      success_url: "https://horas-planetarias.vercel.app/success",
      cancel_url: "https://horas-planetarias.vercel.app/cancel",
    });

    logger.info(`✅ [Stripe Checkout] Sesión creada: ${session.id}`);

    await db.collection("users").doc(uid).set(
      { stripeSessionId: session.id, subscriptionActive: false },
      { merge: true }
    );

    logger.info(`📄 [Stripe Checkout] Usuario guardado: ${uid}`);
    res.json({ sessionId: session.id });
  } catch (err) {
    logger.error("❌ [Stripe Checkout] Error: " + err.message);
    res.status(500).json({ error: err.message, details: err });
  }
});

// Stripe Webhook
app.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    logger.info("🔔 [Stripe Webhook] Evento recibido");
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      logger.info("✅ [Stripe Webhook] Evento validado: " + event.type);
    } catch (err) {
      logger.error("❌ [Stripe Webhook] Error validación: " + err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.metadata?.uid;
      logger.info("⚡ [Stripe Webhook] Checkout completado, UID: " + uid);
      if (uid) {
        await db.collection("users").doc(uid).update({
          subscriptionActive: true,
          stripeCustomerId: session.customer,
          updatedAt: new Date(),
        });
        logger.info("✅ [Stripe Webhook] Usuario activado: " + uid);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const subscriptionId = subscription.id;
      logger.warn("⚡ [Stripe Webhook] Subscripción eliminada: " + subscriptionId);

      if (subscriptionId) {
        const snapshot = await db.collection("users")
          .where("subscriptionId", "==", subscriptionId)
          .get();

        logger.info("📄 [Stripe Webhook] Usuarios encontrados: " + snapshot.size);
        snapshot.forEach((doc) => {
          doc.ref.update({
            subscriptionActive: false,
            updatedAt: new Date(),
          });
          logger.warn("⚡ [Stripe Webhook] Usuario desactivado: " + doc.id);
        });
      }
    }

    res.json({ received: true });
  }
);

// =======================
// MercadoPago Suscripción
// =======================
app.post("/mp-subscription", async (req, res) => {
  logger.info("⚡ [MP Subscription] Request body: " + JSON.stringify(req.body));
  try {
    const { uid, email } = req.body;

    if (!uid || !email) {
      logger.warn("⚠️ [MP Subscription] uid o email faltantes");
      return res.status(400).json({ error: "uid y email son requeridos" });
    }

    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(new Date().setFullYear(start.getFullYear() + 1));

    const response = await preapproval.create({
      body: {
        reason: "Suscripción Mensual - Plan Premium",
        external_reference: uid,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 80,
          currency_id: "UYU",
          start_date: start.toISOString(),
          end_date: end.toISOString(),
        },
        back_url: "https://horas-planetarias.vercel.app/success",
        payer_email: email,
      },
    });

    logger.info("✅ [MP Subscription] Preapproval creado: " + response.id);

    await db.collection("users").doc(uid).set(
      { mpPreapprovalId: response.id, subscriptionActive: false },
      { merge: true }
    );

    logger.info("📄 [MP Subscription] Usuario guardado: " + uid);
    res.json({ init_point: response.init_point });
  } catch (err) {
    logger.error("❌ [MP Subscription] Error: " + err.message);
    res.status(500).json({ error: err.message, details: err.cause || err });
  }
});

// MercadoPago Webhook
app.post("/webhook-mp", express.json({ limit: "1mb" }), async (req, res) => {
  const data = req.body;
  logger.info("🔔 [MP Webhook] Recibido: " + JSON.stringify(data));
  if (data.entity === "preapproval" || data.type === "subscription_preapproval") {
    const preapprovalId = data.data?.id;
    logger.info("🔍 [MP Webhook] Consultando preapproval ID: " + preapprovalId);
    if (preapprovalId) {
      try {
        const preapprovalResp = await preapproval.get({ id: preapprovalId });
        const status = preapprovalResp.status;
        logger.info("✅ [MP Webhook] Estado recibido de MP: " + status);

        const snapshot = await db.collection("users")
          .where("mpPreapprovalId", "==", preapprovalId)
          .get();

        logger.info("📄 [MP Webhook] Usuarios encontrados: " + snapshot.size);
        snapshot.forEach((doc) => {
          doc.ref.update({
            subscriptionActive: status === "authorized",
            updatedAt: new Date(),
          });
          logger.info("⚡ [MP Webhook] Usuario actualizado: " + doc.id + " Status: " + status);
        });
      } catch (err) {
        logger.error("❌ [MP Webhook] Error al consultar preapproval: " + err.message);
      }
    }
  }

  res.json({ received: true });
});

// =======================
// PayPal Suscripción (Producción)
// =======================
async function getPayPalAccessToken() {
  logger.info("⚡ [PayPal] Solicitando accessToken...");
  const response = await axios({
    url: "https://api-m.paypal.com/v1/oauth2/token",
    method: "post",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    auth: {
      username: process.env.PAYPAL_CLIENT_ID,
      password: process.env.PAYPAL_CLIENT_SECRET,
    },
    data: "grant_type=client_credentials",
  });
  logger.info("✅ [PayPal] AccessToken obtenido");
  return response.data.access_token;
}

app.post("/paypal-subscription", async (req, res) => {
  logger.info("⚡ [PayPal Subscription] Request body: " + JSON.stringify(req.body));
  try {
    const { uid, email } = req.body;

    if (!uid || !email) {
      logger.warn("⚠️ [PayPal Subscription] uid o email faltantes");
      return res.status(400).json({ error: "uid y email requeridos" });
    }

    const accessToken = await getPayPalAccessToken();

    const response = await axios.post(
      "https://api-m.paypal.com/v1/billing/subscriptions",
      {
        plan_id: process.env.PAYPAL_PLAN_ID,
        subscriber: { email_address: email },
        application_context: {
          brand_name: "Horas Planetarias",
          return_url: "https://horas-planetarias.vercel.app/success",
          cancel_url: "https://horas-planetarias.vercel.app/cancel",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const sub = response.data;
    logger.info("✅ [PayPal Subscription] Subscripción creada: " + sub.id);

    await db.collection("users").doc(uid).set(
      { paypalSubscriptionId: sub.id, subscriptionActive: false },
      { merge: true }
    );

    logger.info("📄 [PayPal Subscription] Usuario guardado: " + uid);
    const approveUrl = sub.links.find((l) => l.rel === "approve").href;
    res.json({ approveUrl });
  } catch (err) {
    logger.error("❌ [PayPal Subscription] Error: " + (err.response?.data || err.message));
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// =======================
// PayPal Webhook
// =======================
app.post("/webhook-paypal", express.json(), async (req, res) => {
  const event = req.body;
  logger.info("🔔 [PayPal Webhook] Evento recibido: " + event.event_type);

  if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    const subId = event.resource.id;
    logger.info("⚡ [PayPal Webhook] Subscripción activada: " + subId);
    const snapshot = await db.collection("users").where("paypalSubscriptionId", "==", subId).get();
    snapshot.forEach((doc) => {
      doc.ref.update({
        subscriptionActive: true,
        updatedAt: new Date(),
      });
      logger.info("✅ [PayPal Webhook] Usuario activado: " + doc.id);
    });
  }

  if (event.event_type === "BILLING.SUBSCRIPTION.CANCELLED") {
    const subId = event.resource.id;
    logger.warn("⚡ [PayPal Webhook] Subscripción cancelada: " + subId);
    const snapshot = await db.collection("users").where("paypalSubscriptionId", "==", subId).get();
    snapshot.forEach((doc) => {
      doc.ref.update({
        subscriptionActive: false,
        updatedAt: new Date(),
      });
      logger.warn("⚡ [PayPal Webhook] Usuario desactivado: " + doc.id);
    });
  }

  res.sendStatus(200);
});

// =======================
// Estado de suscripción
// =======================
app.get("/subscription-status/:uid", async (req, res) => {
  logger.info("⚡ [Subscription Status] Consultando UID: " + req.params.uid);
  try {
    const { uid } = req.params;
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      logger.warn("⚠️ [Subscription Status] Usuario no encontrado: " + uid);
      return res.json({ subscriptionActive: false });
    }

    const userData = userDoc.data();
    logger.info("✅ [Subscription Status] Usuario: " + uid + " Estado: " + userData.subscriptionActive);
    res.json({ subscriptionActive: userData.subscriptionActive || false });
  } catch (err) {
    logger.error("❌ [Subscription Status] Error: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Start Server
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`🚀 Servidor corriendo en puerto ${PORT}`));
