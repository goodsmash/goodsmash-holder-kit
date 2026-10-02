// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}

/// Free-mint test collection deployed to Robinhood Chain TESTNET (46630).
/// Deliberately mirrors a real free-mint drop: price 0, per-wallet cap,
/// max supply, pausable, and an enumerable ownership index.
contract TestnetFreeMint is IERC721 {
    string public name = "Holder Kit Test Drop";
    string public symbol = "HKT";

    uint256 public mintPrice;      // 0 == free
    uint256 public maxSupply = 500;
    uint256 public totalMinted;
    uint256 public maxPerWallet = 3;
    bool public saleIsActive = true;
    bool public paused;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(address => uint256[]) private _tokensOf;

    event Minted(address indexed to, uint256 qty, uint256 tokenId);

    function mint(uint256 qty) external payable {
        require(!paused, "paused");
        require(saleIsActive, "inactive");
        require(msg.value == mintPrice * qty, "wrong price");
        require(totalMinted + qty <= maxSupply, "sold out");
        require(_balanceOf[msg.sender] + qty <= maxPerWallet, "per wallet limit");
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalMinted;
            _ownerOf[id] = msg.sender;
            _balanceOf[msg.sender] += 1;
            _tokensOf[msg.sender].push(id);
            emit Minted(msg.sender, 1, id);
        }
    }

    /// Bulk mint straight to an address, so a test can seed several wallets.
    function mintTo(address to, uint256 qty) external {
        require(!paused, "paused");
        require(totalMinted + qty <= maxSupply, "sold out");
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalMinted;
            _ownerOf[id] = to;
            _balanceOf[to] += 1;
            _tokensOf[to].push(id);
            emit Minted(to, 1, id);
        }
    }

    function owner(uint256 tokenId) external view returns (address) { return _ownerOf[tokenId]; }

    function setPrice(uint256 p) external { mintPrice = p; }
    function setActive(bool a) external { saleIsActive = a; }
    function setPaused(bool p) external { paused = p; }
    function setMaxSupply(uint256 s) external { maxSupply = s; }
    function setMaxPerWallet(uint256 m) external { maxPerWallet = m; }

    function balanceOf(address a) external view returns (uint256) { return _balanceOf[a]; }
    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _ownerOf[tokenId];
        require(o != address(0), "nonexistent");
        return o;
    }
    function totalSupply() external view returns (uint256) { return totalMinted; }

    function tokenOfOwnerByIndex(address a, uint256 i) external view returns (uint256) {
        return _tokensOf[a][i];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owner");
        delete _ownerOf[tokenId];
        _balanceOf[from] -= 1;
        _tokensOf[from].pop();
        _ownerOf[tokenId] = to;
        _balanceOf[to] += 1;
        _tokensOf[to].push(tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owner");
        require(to != address(0), "to zero");
        delete _ownerOf[tokenId];
        _balanceOf[from] -= 1;
        _tokensOf[from].pop();
        _ownerOf[tokenId] = to;
        _balanceOf[to] += 1;
        _tokensOf[to].push(tokenId);
    }

    function approve(address, uint256) external pure returns (bool) { return true; }
    function setApprovalForAll(address, bool) external pure returns (bool) { return true; }
    function isApprovedForAll(address, address) external pure returns (bool) { return true; }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true; // matches both 0x80ac58cd (721) and 0xd9b67a26 (1155)
    }
}
