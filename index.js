const express = require("express");
const { MongoClient } = require("mongodb");
const handlebars = require("express-handlebars");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.engine("handlebars", handlebars.engine());
app.set("view engine", "handlebars");
app.set("views", "./views");
app.use(express.static(path.join(__dirname, "public")));

let config_horarios;
let clientes;
let agendamentos;

// função de montagem da agenda dinamica
async function gerarAgendaCompleta() {
  const dias = ["SEG", "TER", "QUA", "QUI", "SEX", "SAB"];
  const horas = [
    "08:00",
    "09:00",
    "10:00",
    "11:00",
    "14:00",
    "15:00",
    "16:00",
    "17:00",
  ];

  // busca as configurações e os agendamentos já marcados no banco
  const configsBanco = await config_horarios.find().toArray();
  const agendamentosBanco = await agendamentos.find().toArray();

  const agendaSemana = [];
  let idCount = 1;

  for (let dia of dias) {
    let horariosDia = [];

    for (let hora of horas) {
      // 1. Descobre a capacidade (Se o admin não mexeu, o padrão é 1)
      let config = configsBanco.find(
        (c) => c.dia === dia && c.horario === hora,
      );
      let capacidade = config ? parseInt(config.capacidade) : 1;

      // 2. Conta quantas pessoas já agendaram neste dia/hora
      let qtdOcupada = agendamentosBanco.filter(
        (a) => a.dia === dia && a.hora === hora,
      ).length;

      // 3. Calcula as vagas restantes
      let vagasRestantes = capacidade - qtdOcupada;

      horariosDia.push({
        id: "slot_" + idCount++,
        hora: hora,
        vagas: vagasRestantes > 0 ? vagasRestantes : 0, // Se der negativo, trava no zero
      });
    }
    agendaSemana.push({ dia: dia, horarios: horariosDia });
  }

  return agendaSemana;
}

// Rotas do Sistema
// Rota 1: Tela Inicial (Cliente)
app.get("/", async (req, resp) => {
  const agendaSemana = await gerarAgendaCompleta();
  resp.render("cliente", { semana: agendaSemana });
});

// Rota 2: Salvar o Agendamento no Banco
app.post("/agendar", async (req, resp) => {
  let dadosCliente = req.body;
  const cpfLimpo = dadosCliente.cpf.replace(/\D/g, "");

  if (cpfLimpo.length !== 11) {
    return resp.send(`
        <script>
            alert("⚠️ CPF inválido! O CPF precisa ter exatamente 11 números.");
            window.location.href = "/";
        </script>
      `);
  }

  try {
    // tratamento de requisiçoes simultaneas para o mesmo horário, evitando overbooking
    // A. Descobre a capacidade configurada para aquele dia/hora
    const config = await config_horarios.findOne({
      dia: dadosCliente.dia,
      horario: dadosCliente.hora,
    });
    const capacidadeMaxima = config ? parseInt(config.capacidade) : 1;

    // B. Conta quantos agendamentos já existem lá no banco
    const qtdOcupada = await agendamentos.countDocuments({
      dia: dadosCliente.dia,
      hora: dadosCliente.hora,
    });

    // C. Verifica se o limite foi atingido entre o momento em que o
    // utilizador abriu a página e o momento em que carregou em "Agendar"
    if (qtdOcupada >= capacidadeMaxima) {
      return resp.send(`
          <script>
              alert("⚠️ Lamentamos! A vaga para ${dadosCliente.dia} às ${dadosCliente.hora} acabou de ser preenchida por outro utilizador. Por favor, escolha outro horário.");
              window.location.href = "/";
          </script>
        `);
    }

    // validação de clientes existentes, evitando que o mesmo CPF seja registrado com nomes diferentes
    const clienteExistente = await clientes.findOne({ cpf: dadosCliente.cpf });

    if (clienteExistente) {
      if (clienteExistente.nome !== dadosCliente.nome) {
        return resp.send(`
          <script>
              alert("⚠️ Operação bloqueada: O CPF ${dadosCliente.cpf} já está registado em nome de ${clienteExistente.nome}. Verifique os dados digitados.");
              window.location.href = "/";
          </script>
        `);
      }
    } else {
      await clientes.insertOne({
        nome: dadosCliente.nome,
        cpf: dadosCliente.cpf,
      });
    }

    await agendamentos.insertOne({
      dia: dadosCliente.dia,
      hora: dadosCliente.hora,
      nome: dadosCliente.nome,
      cpf: dadosCliente.cpf,
      pet: dadosCliente.pet,
    });

    resp.send(`
      <script>
          alert("🐾 Sucesso! O horário para o pet ${dadosCliente.pet} foi agendado!");
          window.location.href = "/";
      </script>
    `);
  } catch (erro) {
    console.error(erro);
    resp.send(`
      <script>
          alert("❌ Ocorreu um erro interno no servidor.");
          window.location.href = "/";
      </script>
    `);
  }
});

// Rotas de Login e Administração
// Rota: Mostrar a tela de login
app.get("/login", async (req, resp) => {
  resp.render("login");
});

// Rota: Verificar usuário e senha
app.post("/login", async (req, resp) => {
  const { usuario, senha } = req.body;

  // Verifica se as credenciais batem
  if (usuario === "admin" && senha === "12345") {
    // Senha correta: Manda direto para a lista de agendamentos
    resp.redirect("/listaPetAgenda");
  } else {
    // Senha incorreta: Mostra um alerta e faz a pessoa tentar de novo
    resp.send(`
        <script>
            alert("❌ Usuário ou senha incorretos! Tente novamente.");
            window.location.href = "/login";
        </script>
      `);
  }
});

// Rota 3: Tela de Configuração (Admin)
app.get("/ajustaPetAgenda", async (req, resp) => {
  resp.render("ajusteAgenda");
});

// Rota 4: Salvar a Configuração de Capacidade
app.post("/ajustaPetAgenda", async (req, resp) => {
  let { dia, horario, capacidade } = req.body;

  // Atualiza a capacidade no banco
  await config_horarios.updateOne(
    { dia: dia, horario: horario },
    { $set: { capacidade: parseInt(capacidade) } },
    { upsert: true },
  );

  resp.send(`
    <script>
        alert("✅ Configuração guardada: ${dia} às ${horario} agora tem ${capacidade} vaga(s).");
        window.location.href = "/ajustaPetAgenda";
    </script>
  `);
});

// Rota 5: Lista de Agendamentos (Admin)
app.get("/listaPetAgenda", async (req, resp) => {
  // Busca todos os agendamentos no banco
  const lista = await agendamentos.find().toArray();
  resp.render("listaAgenda", { listaAgendamentos: lista });
});

// Conerwctando ao bd e iniciando o servidor
async function conecta() {
  try {
    const client = new MongoClient("mongodb://127.0.0.1:27017");
    await client.connect();

    const db = client.db("petshop");
    config_horarios = db.collection("config_horarios");
    clientes = db.collection("clientes");
    agendamentos = db.collection("agendamentos");

    console.log("Sucesso: Conectado ao MongoDB!");
    app.listen(3000, "0.0.0.0", () =>
      console.log("Servidor liberado para a rede na porta 3000"),
    );
  } catch (erro) {
    console.error("Erro ao conectar no MongoDB:", erro);
  }
}
conecta();
