const { Connection, PublicKey } = require("@solana/web3.js");
const { Token, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const readline = require("readline");
const axios = require("axios");

const token = "example token for bot";
const chatId = "-4766203625";
// Create a bot that uses 'polling' to fetch new updates
const bot_username = "@SolanaInspector_bot";
let tnx_lookup_no = 10;
async function sendTelegramMessage(message, maxRetries = 3) {
  const encodedMessage = encodeURIComponent(message);
  const API_URL =
    "https://api.telegram.org/bot" +
    token +
    "/sendMessage?chat_id=" +
    chatId +
    "&text=" +
    encodedMessage;

  let retries = 0;

  while (retries < maxRetries) {
    try {
      const response = await axios.get(API_URL, {
        timeout: 20000,
      });

      if (response.data && response.data.ok) {
        console.log("Telegram message sent successfully");
        return response.data;
      } else {
        console.log(
          "Telegram API returned unsuccessful response:",
          response.data
        );
        retries++;
        // Wait a bit before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      }
    } catch (error) {
      console.log(
        `Telegram message error (attempt ${retries + 1}/${maxRetries}):`,
        error.message
      );
      retries++;

      // Wait a bit before retrying (exponential backoff)
      if (retries < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  console.log("Failed to send Telegram message after maximum retries");
  return null;
}
// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to prompt for input
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}
class TokenMonitor {
  constructor(rpcEndpoint, tokenMint, targetWallet, maxDepth = 3) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
    this.tokenMint = new PublicKey(tokenMint);
    this.targetWallet = new PublicKey(targetWallet);
    this.maxDepth = maxDepth;
    this.lastSignature = null;
    this.checkedSignatures = new Set();
    this.walletCache = new Map();
    this.txFundingAccountsCache = new Map();
    this.organicBuyerList = [];
    this.tnxNo = 0;
    this.stackedWallets = new Set();
    this.totMint = 0;
  }

  async startMonitoring() {
    await this.checkNewTransactions();

    setInterval(async () => {
      try {
        await this.checkNewTransactions();
      } catch (error) {
        console.error("Monitoring error:", error);
      }
    }, 5000);
  }

  async checkNewTransactions() {
    const transactions = await this.connection.getSignaturesForAddress(
      this.tokenMint,
      {
        until: this.lastSignature,
        limit: 7,
      }
    );

    if (transactions.length === 0) {
      console.log("No new transactions found");
      return;
    }
    this.lastSignature = transactions[0].signature;

    for (const tx of transactions) {
      const parsedTx = await this.connection.getParsedTransaction(
        tx.signature,
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0, // Add this parameter
        }
      );

      await this.processTransaction(parsedTx);
    }
  }

  async processTransaction(parsedTx) {
    try {
      console.log("processTransaction....");

      const buyerWallet = await this.detectTokenBuy(parsedTx);
      if (buyerWallet) {
        console.log("********Buy transaction detected in logs");
        const isFunded = await this.checkFundingSource(
          buyerWallet,
          this.targetWallet,
          0
        );
        if (isFunded) {
          console.log("***************funding source in-organic wallet*******");
        } else {
          console.log(
            "***************funding source organic wallet",
            this.organicBuyerList
          );
          if (!parsedTx || !parsedTx.meta) {
            console.log("No transaction metadata available");
            return null;
          }

          // Method 1: Calculate total SOL balance change for buyer
          const buyerIndex = parsedTx.transaction.message.accountKeys.findIndex(
            (account) => account.pubkey.toString() === buyerWallet
          );

          let solBalanceChange = 0;
          if (
            buyerIndex !== -1 &&
            parsedTx.meta.preBalances &&
            parsedTx.meta.postBalances
          ) {
            const preBal = parsedTx.meta.preBalances[buyerIndex];
            const postBal = parsedTx.meta.postBalances[buyerIndex];
            solBalanceChange = (preBal - postBal) / 1e9; // Convert lamports to SOL

            // Subtract transaction fee (paid by fee payer, which may be buyer)
            const feePayerIndex =
              parsedTx.transaction.message.accountKeys.findIndex(
                (account) =>
                  account.signer === true && account.writable === true
              );

            if (feePayerIndex === buyerIndex && parsedTx.meta.fee) {
              solBalanceChange -= parsedTx.meta.fee / 1e9;
            }

            console.log(
              `Wallet ${buyerWallet} bought tokens for ${solBalanceChange} SOL`
            );

            this.organicBuyerList.push({
              wallet: buyerWallet,
              amount: solBalanceChange,
            });
            this.totMint += solBalanceChange;
            const message = `Total sol bought = ${this.totMint} \nWallet ${buyerWallet} bought tokens for ${solBalanceChange} SOL`;
            try {
              sendTelegramMessage(message);
            } catch (error) {
              console.log("error in sending telegram message", error);
            }
          }
        }
        console.log(`----Wallet ${buyerWallet} funded by target: ${isFunded}`);
      }
    } catch (error) {
      console.error("Transaction processing error:", error.message);
    }
  }

  async detectTokenBuy(parsedTx) {
    try {
      let isbuy = false;
      let owner = null;
      // Analyze token balance changes
      parsedTx.meta.postTokenBalances.forEach((post) => {
        const pre = parsedTx.meta.preTokenBalances.find(
          (pre) => pre.accountIndex === post.accountIndex
        );

        if (post.mint === this.tokenMint.toString()) {
          const change =
            BigInt(post.uiTokenAmount.amount) -
            BigInt(pre.uiTokenAmount.amount);
          if (change > 0) {
            isbuy = true;
            owner = post.source;
            console.log("tokenChanges: ", tokenChanges);
          }
        }
      });

      if (isbuy == false) return null;

      // Find the actual buyer (exclude intermediate accounts)
      if (owner) {
        console.log("owner: ", owner);
        const accountInfo = await this.connection.getAccountInfo(
          new PublicKey(owner)
        );

        if (!accountInfo?.owner.equals(TOKEN_PROGRAM_ID)) {
          return owner;
        }
      }

      return null;
    } catch (error) {
      return this.checkBuyInstructionInLogs(parsedTx);
    }
  }
  checkBuyInstructionInLogs(parsedTx) {
    if (!parsedTx?.meta?.logMessages) {
      console.warn("Transaction logs are missing. tnx", parsedTx);

      return null;
    }

    const isBuyTransaction = parsedTx.meta.logMessages.some((log) =>
      log.includes("Instruction: Buy")
    );

    if (isBuyTransaction) {
      if (
        parsedTx.transaction.version == undefined ||
        parsedTx.transaction.version == "Legacy" ||
        parsedTx.transaction.version == "0"
      ) {
        // For legacy transactions, extract the signers manually

        const signer = parsedTx.transaction.message.accountKeys.find(
          (account) => account.signer == true
        );
        return signer.pubkey.toString();
      } else {
        // For version 0, 1, and 2, you can directly access signers
        const signer = parsedTx.transaction.message.accountKeys.find(
          (account) => account.isSigner == true
        );
        return signer.pubkey.toString();
      }
    }
  }

  async checkFundingSource(wallet, target, currentDepth) {
    if (currentDepth > this.maxDepth) return false;

    if (this.walletCache.has(wallet)) {
      console.log(`Cache hit for ${wallet}`);
      return this.walletCache.get(wallet);
    }

    console.log(
      `Checking funding for ${wallet} at depth ${currentDepth} for tnxNo: ${this.tnxNo}`
    );

    // Check direct funding
    const accountInfo = await this.connection.getAccountInfo(
      new PublicKey(wallet),
      "finalized"
    );

    if (accountInfo?.owner.equals(target)) {
      this.walletCache.set(wallet, true);
      return true;
    }

    // Check transaction history
    const signatures = await this.connection.getSignaturesForAddress(
      new PublicKey(wallet),
      {
        limit: tnx_lookup_no,
      }
    );

    for (const { signature } of signatures) {
      let fundingSource = [];

      if (this.txFundingAccountsCache.has(signature)) {
        console.log(`Cache hit for related accounts to :${signature}`);
        fundingSource = this.txFundingAccountsCache.get(signature);
      } else {
        const tx = await this.connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });

        // Analyze instruction
        if (!tx) continue;
        if (
          tx.transaction.version == undefined ||
          tx.transaction.version == "Legacy" ||
          tx.transaction.version == "0"
        ) {
          // For legacy transactions, extract the signers manually
          fundingSource = tx.transaction.message.accountKeys
            .filter((account) => account.signer == true)
            .map((account) => account.pubkey.toString());
        } else {
          // For version 0, 1, and 2, you can directly access signers
          fundingSource = tx.transaction.message.accountKeys
            .filter((account) => account.isSigner === true)
            .map((account) => account.pubkey.toString());
        }

        console.log("cache", signature.substring(0, 6), "---->", [
          fundingSource[0],
        ]);
        this.txFundingAccountsCache.set(signature, [fundingSource[0]]);
      }
      if (fundingSource.length === 0) {
        console.log("no funding source");
        return false;
      }

      console.log(" check ", fundingSource, "==", target.toString());
      if (fundingSource.includes(target.toString())) {
        console.log("***************funding source equal target");
        this.walletCache.set(wallet, true);
        return true;
      }

      // Recursive check

      if (fundingSource[0] && wallet !== fundingSource[0]) {
        if (
          await this.checkFundingSource(
            fundingSource[0],
            target,
            currentDepth + 1
          )
        ) {
          this.walletCache.set(wallet, true);
          return true;
        }
      }
    }

    this.walletCache.set(wallet, false);
    this.tnxNo++;
    return false;
  }

  async analyzeInstruction(ix, recipient) {
    try {
      console.log("ix: \n", ix);
      // System transfer
      if (ix.programId.equals(PublicKey.default)) {
        console.log("-----------native sol-------");
        if (ix.parsed?.type === "transfer") {
          return new PublicKey(ix.parsed.info.source);
        }
      }

      // SPL token transfer
      if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
        if (
          ix.parsed?.type === "transfer" ||
          ix.parsed?.type === "transferChecked"
        ) {
          const source = new PublicKey(ix.parsed.info.source);
          const accountInfo = await this.connection.getAccountInfo(source);
          return accountInfo?.owner;
        }
      }

      return null;
    } catch (error) {
      console.error("Instruction analysis error:", error.message);
      return null;
    }
  }
}

let TOKEN_ADDRESS = "";
let TARGET_WALLET = "";
let MAX_DEPTH = 3;

//get through user input in terminal

async function main() {
  await prompt("\nEnter to start... ");
  TOKEN_ADDRESS = await prompt("\nEnter token address: ");
  console.log("TOKEN_ADDRESS", TOKEN_ADDRESS);
  TARGET_WALLET = await prompt("Enter target wallet address: ");
  console.log("TARGET_WALLET", TARGET_WALLET);
  //tnx_lookup_no
  const no_tnxs = await prompt("Enter tnx lookup no: ");
  tnx_lookup_no = parseInt(no_tnxs);
  console.log("tnx_lookup_no", tnx_lookup_no);
  MAX_DEPTH = await prompt("Enter max depth: ");
  console.log("MAX_DEPTH", MAX_DEPTH);
  const monitor = new TokenMonitor(
    "https://mainnet.helius-rpc.com/?api-key=",
    TOKEN_ADDRESS,
    TARGET_WALLET,
    parseInt(MAX_DEPTH)
  );
  monitor.startMonitoring().catch(console.error);
}
// const monitor = new TokenMonitor(
//   // "https://solana-api.instantnodes.io/token-instant node",
//   "https://mainnet.helius-rpc.com/?api-key=key helius",
//   "4cB5Qkx638ySvDAkRAk6EmHxXvHxpdh8wBP1jMNxpump",
//   "H5ft7mjHYafZJCP9UPRu7yP66enrL9t8Hc8ohwyoC9bL",
//   3 // Max depth
// );
main().catch(console.error);
