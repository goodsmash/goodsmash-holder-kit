// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title MultiMint — a deliberately realistic free-mint drop for the proof.
/// @notice Models the shapes real drops actually have, so the toolkit is tested
///         against realistic behaviour rather than one friendly happy path:
///         - a free public mint with a per-wallet cap
///         - an allowlist mint for a specific wallet
///         - a paid public mint (price > 0)
///         - pausable by the owner
///         - a capped total supply that genuinely sells out
///         - enumerable tokens, so inventory reads can be verified exactly
contract MultiMint {
    string public constant name = "MultiMint Proof";
    string public constant symbol = "MMP";
    uint256 public MAX_SUPPLY = 500;
    uint256 public constant MAX_PER_WALLET = 3;
    uint256 public constant FREE_PRICE = 0;
    uint256 public constant PAID_PRICE = 0.0005 ether;

    address public owner;
    bool public paused;
    uint256 public freePrice = FREE_PRICE;
    uint256 public paidPrice = PAID_PRICE;

    mapping(address => bool) public allowlisted;
    mapping(address => uint256) public minted;
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256[]) private _tokens;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Mint(address indexed who, uint256 qty, uint256 paid);
    event Paused(bool value);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function mint(uint256 qty) external payable {
        require(!paused, "paused");
        require(qty > 0 && qty <= MAX_PER_WALLET, "bad qty");
        require(totalSupply + qty <= MAX_SUPPLY, "sold out");

        uint256 price = freePrice;
        require(msg.value == price, "wrong price");

        require(minted[msg.sender] + qty <= MAX_PER_WALLET, "per wallet limit");
        minted[msg.sender] += qty;

        uint256 paid;
        if (msg.value > 0) {
            (bool ok, ) = payable(owner).call{value: msg.value}("");
            require(ok, "payment failed");
            paid = msg.value;
        }

        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalSupply;
            _ownerOf[id] = msg.sender;
            _tokens[msg.sender].push(id);
            emit Transfer(address(0), msg.sender, id);
        }
        emit Mint(msg.sender, qty, paid);
    }

    /// Allowlisted wallets mint free even while the public mint is priced.
    function claim(uint256 qty) external {
        require(!paused, "paused");
        require(allowlisted[msg.sender], "not allowlisted");
        require(qty > 0 && minted[msg.sender] + qty <= MAX_PER_WALLET, "per wallet limit");
        require(totalSupply + qty <= MAX_SUPPLY, "sold out");
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalSupply;
            _ownerOf[id] = msg.sender;
            _tokens[msg.sender].push(id);
            emit Transfer(address(0), msg.sender, id);
        }
        emit Mint(msg.sender, qty, 0);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _ownerOf[tokenId];
        require(o != address(0), "nonexistent");
        return o;
    }

    function balanceOf(address who) external view returns (uint256) {
        return _tokens[who].length;
    }

    function tokensOfOwner(address who) external view returns (uint256[] memory) {
        return _tokens[who];
    }

    /// ERC-721 Enumerable. isEnumerable() probes this with a REAL owner address;
    /// without it the toolkit correctly refuses to spread, because it cannot
    /// list which token ids a holder actually owns.
    function tokenOfOwnerByIndex(address who, uint256 index) external view returns (uint256) {
        require(index < _tokens[who].length, "out of range");
        return _tokens[who][index];
    }

    function totalMinted() external view returns (uint256) {
        return totalSupply;
    }

    function mintCost(uint256 qty) external view returns (uint256) {
        return freePrice * qty;
    }

    function isPaused() external view returns (bool) {
        return paused;
    }

    /// ERC-165. Without this, detectStandard() returns UNKNOWN and the toolkit
    /// correctly refuses to spread — so a contract that is a perfectly valid
    /// ERC-721 but omits the helper looks unsupported.
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd // ERC721
            || id == 0x5b5e139f // ERC721Metadata
            || id == 0x01ffc9a7; // ERC165
    }

    function setPaused(bool v) external onlyOwner {
        paused = v;
        emit Paused(v);
    }

    /// Switch the public mint between free and priced — lets the proof prove it
    /// reports the price change from chain state rather than a cached guess.
    function setFreePrice(uint256 p) external onlyOwner {
        freePrice = p;
    }

    function setAllowlisted(address who, bool v) external onlyOwner {
        allowlisted[who] = v;
    }

    function setMaxSupply(uint256 s) external onlyOwner {
        require(s >= totalSupply, "below supply");
        MAX_SUPPLY = s;
    }

    /// The proof lowers MAX_SUPPLY to test the sold-out path. On a REUSED
    /// contract that is permanent, so every later run then reverts with
    /// "sold out" during minting and looks like a toolkit bug. Restore it.
    function resetSupply() external onlyOwner {
        MAX_SUPPLY = 500;
    }

    /// spread() uses safeTransferFrom, which every real ERC-721 has. A fixture
    /// implementing only transferFrom looks fine but cannot be sent from, which
    /// reads as a toolkit failure rather than a missing fixture function.
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owner");
        require(msg.sender == from || msg.sender == owner, "not approved");
        require(to != address(0), "zero to");
        _ownerOf[tokenId] = to;

        uint256[] storage list = _tokens[from];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == tokenId) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }
        _tokens[to].push(tokenId);
        emit Transfer(from, to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owner");
        require(from == msg.sender || msg.sender == owner, "not approved");
        require(to != address(0), "zero to");
        _ownerOf[tokenId] = to;

        uint256[] storage list = _tokens[from];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == tokenId) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }
        _tokens[to].push(tokenId);
        emit Transfer(from, to, tokenId);
    }
}