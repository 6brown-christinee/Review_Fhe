pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract ReviewFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => euint32) public encryptedReviewSumForBatch;
    mapping(uint256 => euint32) public encryptedReviewCountForBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ReviewSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedReview);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 averageReview);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayDetected();
    error StateMismatch();
    error InvalidBatchId();
    error FHEResultNotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier respectCooldown(address _user) {
        if (block.timestamp < lastSubmissionTime[_user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1;
        _openBatch(currentBatchId);
        cooldownSeconds = 60; // Default cooldown: 60 seconds
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        _closeBatch(currentBatchId);
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) internal {
        isBatchOpen[batchId] = true;
        encryptedReviewSumForBatch[batchId] = FHE.asEuint32(0);
        encryptedReviewCountForBatch[batchId] = FHE.asEuint32(0);
        emit BatchOpened(batchId);
    }

    function _closeBatch(uint256 batchId) internal {
        if (isBatchOpen[batchId]) {
            isBatchOpen[batchId] = false;
            emit BatchClosed(batchId);
        }
    }

    function submitReview(uint256 batchId, euint32 encryptedReview) external onlyProvider whenNotPaused respectCooldown(msg.sender) {
        if (!isBatchOpen[batchId]) revert BatchClosedOrInvalid();

        encryptedReviewSumForBatch[batchId] = encryptedReviewSumForBatch[batchId].add(encryptedReview);
        encryptedReviewCountForBatch[batchId] = encryptedReviewCountForBatch[batchId].add(FHE.asEuint32(1));
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit ReviewSubmitted(msg.sender, batchId, encryptedReview);
    }

    function requestAverageReviewDecryption(uint256 batchId) external whenNotPaused respectCooldown(msg.sender) {
        if (!isBatchOpen[batchId] && batchId != currentBatchId) revert InvalidBatchId(); // Allow requesting for current (open) or recently closed batch

        euint32 sum = encryptedReviewSumForBatch[batchId];
        euint32 count = encryptedReviewCountForBatch[batchId];
        _requireInitialized(sum);
        _requireInitialized(count);

        euint32 average = sum.mul(FHE.inv(count)); // FHE division via multiplication with inverse

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(average);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        // Security: Replay protection ensures a decryption request is processed only once.

        uint256 batchId = decryptionContexts[requestId].batchId;

        // Security: State verification ensures that the contract state (specifically, the ciphertexts
        // that were meant to be decrypted) has not changed between the request and the callback.
        // This prevents scenarios where an attacker might alter the data after a request is made
        // but before it's decrypted, leading to inconsistent or maliciously influenced results.
        bytes32 currentHash;
        if (batchId == decryptionContexts[requestId].batchId) { // Ensure batchId is consistent
            euint32 sum = encryptedReviewSumForBatch[batchId];
            euint32 count = encryptedReviewCountForBatch[batchId];
            _requireInitialized(sum);
            _requireInitialized(count);
            euint32 currentAverage = sum.mul(FHE.inv(count));
            bytes32[] memory currentCts = new bytes32[](1);
            currentCts[0] = FHE.toBytes32(currentAverage);
            currentHash = _hashCiphertexts(currentCts);
        } else {
            revert InvalidBatchId(); // Should not happen if requestId is valid
        }

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32 averageReview = abi.decode(cleartexts, (uint32));
        decryptionContexts[requestId].processed = true;

        emit DecryptionCompleted(requestId, batchId, averageReview);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!FHE.isInitialized(value)) {
            FHE.init(value);
        }
    }

    function _requireInitialized(euint32 value) internal pure {
        if (!FHE.isInitialized(value)) {
            revert FHEResultNotInitialized();
        }
    }
}